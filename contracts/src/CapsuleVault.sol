// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {PqAuth} from "./PqAuth.sol";

/// @title CapsuleVault
/// @notice The timer and the rules of a capsule: release sealed files at a set time, to family after
/// a waiting period the owner can cancel, or if the owner stops checking in. QoreChain has no
/// cryptographic time lock, so this is a threshold-and-wait lock: guardians hold sealed shares of the
/// capsule key and release them only when this contract says the capsule is released.
/// Every owner and guardian action is authorised by that account's ML-DSA-87 key (PqAuth).
contract CapsuleVault is PqAuth {
    enum Mode {
        AtTime, // opens at releaseAt
        AfterWait, // a guardian requests; opens waitSeconds later unless the owner rejects or cancels
        IfQuiet // opens quietSeconds after the owner's last check-in
    }

    enum Status {
        None,
        Armed,
        Requested,
        Released,
        Cancelled
    }

    struct Capsule {
        address owner;
        Mode mode;
        Status status;
        uint8 threshold;
        uint64 releaseAt;
        uint64 waitSeconds;
        uint64 quietSeconds;
        uint64 accessSeconds; // how long recipients may collect after release (guardians honour it)
        uint64 createdAt;
        uint64 requestedAt;
        uint64 releasedAt;
        address requestedBy;
        bytes32 planHash; // hash of the sealed plan (recipients, share envelopes)
    }

    uint64 public constant MIN_WAIT = 1 hours;
    uint64 public constant MAX_WAIT = 365 days;
    uint64 public constant MIN_QUIET = 1 days;
    uint64 public constant MAX_QUIET = 5 * 365 days;
    uint8 public constant MAX_GUARDIANS = 16;

    mapping(bytes32 => Capsule) internal _capsules;
    mapping(bytes32 => address[]) internal _guardians;
    mapping(bytes32 => mapping(address => bool)) public isGuardian;
    mapping(address => uint64) public lastCheckIn;

    event CapsuleCreated(
        bytes32 indexed id, address indexed owner, Mode mode, uint8 threshold, uint64 releaseAt, uint64 waitSeconds, uint64 quietSeconds
    );
    event GuardiansSet(bytes32 indexed id, address[] guardians, uint8 threshold, bytes32 planHash);
    event CheckedIn(address indexed owner, uint64 at);
    event ReleaseRequested(bytes32 indexed id, address indexed guardian, uint64 at, uint64 opensAt);
    event RequestRejected(bytes32 indexed id, address indexed owner, uint64 at);
    event Released(bytes32 indexed id, uint64 at, bytes32 reason);
    event Cancelled(bytes32 indexed id, address indexed owner, uint64 at);

    error CapsuleExists(bytes32 id);
    error NoCapsule(bytes32 id);
    error NotOwner(bytes32 id);
    error NotGuardian(bytes32 id, address account);
    error BadPlan();
    error WrongState(Status status);
    error NotYet(uint64 opensAt);

    // ---- views ------------------------------------------------------------------------------

    function capsule(bytes32 id) external view returns (Capsule memory c, address[] memory guardians) {
        return (_capsules[id], _guardians[id]);
    }

    /// @notice What the status would be if someone finalised now. Guardians release shares only on the
    /// stored status Released (read with capsule()), never on this view: until a release is finalised
    /// the owner keeps control, so a late check-in or a cancel still wins.
    function effectiveStatus(bytes32 id) public view returns (Status) {
        Capsule storage c = _capsules[id];
        if (c.status == Status.Armed || c.status == Status.Requested) {
            uint64 at = opensAt(id);
            if (at != 0 && block.timestamp >= at) return Status.Released;
        }
        return c.status;
    }

    /// @notice When the capsule opens if nothing changes; 0 if no time is running.
    function opensAt(bytes32 id) public view returns (uint64) {
        Capsule storage c = _capsules[id];
        if (c.status != Status.Armed && c.status != Status.Requested) return 0;
        if (c.mode == Mode.AtTime) return c.releaseAt;
        if (c.mode == Mode.AfterWait) return c.status == Status.Requested ? c.requestedAt + c.waitSeconds : 0;
        uint64 last = lastCheckIn[c.owner] > c.createdAt ? lastCheckIn[c.owner] : c.createdAt;
        return last + c.quietSeconds;
    }

    // ---- owner ------------------------------------------------------------------------------

    function create(
        address owner,
        bytes32 id,
        Mode mode,
        address[] calldata guardians,
        uint8 threshold,
        uint64 releaseAt,
        uint64 waitSeconds,
        uint64 quietSeconds,
        uint64 accessSeconds,
        bytes32 planHash,
        bytes calldata pqSignature
    ) external {
        if (_capsules[id].status != Status.None) revert CapsuleExists(id);
        _checkGuardians(owner, guardians, threshold);
        if (mode == Mode.AtTime && releaseAt <= block.timestamp) revert BadPlan();
        if (mode == Mode.AfterWait && (waitSeconds < MIN_WAIT || waitSeconds > MAX_WAIT)) revert BadPlan();
        if (mode == Mode.IfQuiet && (quietSeconds < MIN_QUIET || quietSeconds > MAX_QUIET)) revert BadPlan();
        if (accessSeconds == 0) revert BadPlan();
        _authorise(
            owner,
            keccak256(
                abi.encode(
                    keccak256("create"), id, mode, guardians, threshold, releaseAt, waitSeconds, quietSeconds, accessSeconds, planHash
                )
            ),
            pqSignature
        );
        _capsules[id] = Capsule({
            owner: owner,
            mode: mode,
            status: Status.Armed,
            threshold: threshold,
            releaseAt: mode == Mode.AtTime ? releaseAt : 0,
            waitSeconds: mode == Mode.AfterWait ? waitSeconds : 0,
            quietSeconds: mode == Mode.IfQuiet ? quietSeconds : 0,
            accessSeconds: accessSeconds,
            createdAt: uint64(block.timestamp),
            requestedAt: 0,
            releasedAt: 0,
            requestedBy: address(0),
            planHash: planHash
        });
        _storeGuardians(id, guardians);
        emit CapsuleCreated(id, owner, mode, threshold, releaseAt, waitSeconds, quietSeconds);
        emit GuardiansSet(id, guardians, threshold, planHash);
    }

    /// @notice Replace guardians after the owner re-split the key; old shares stop fitting.
    function setGuardians(address owner, bytes32 id, address[] calldata guardians, uint8 threshold, bytes32 planHash, bytes calldata pqSignature)
        external
    {
        Capsule storage c = _live(id);
        if (c.owner != owner) revert NotOwner(id);
        _checkGuardians(owner, guardians, threshold);
        _authorise(owner, keccak256(abi.encode(keccak256("setGuardians"), id, guardians, threshold, planHash)), pqSignature);
        address[] storage old = _guardians[id];
        for (uint256 i = 0; i < old.length; i++) isGuardian[id][old[i]] = false;
        delete _guardians[id];
        _storeGuardians(id, guardians);
        c.threshold = threshold;
        c.planHash = planHash;
        emit GuardiansSet(id, guardians, threshold, planHash);
    }

    /// @notice A signed heartbeat: resets every IfQuiet capsule of this owner.
    function checkIn(address owner, bytes calldata pqSignature) external {
        _authorise(owner, keccak256(abi.encode(keccak256("checkIn"))), pqSignature);
        lastCheckIn[owner] = uint64(block.timestamp);
        emit CheckedIn(owner, uint64(block.timestamp));
    }

    /// @notice Owner turns down a pending request; the guardian stays a guardian.
    function reject(address owner, bytes32 id, bytes calldata pqSignature) external {
        Capsule storage c = _live(id);
        if (c.owner != owner) revert NotOwner(id);
        if (c.status != Status.Requested) revert WrongState(c.status);
        _authorise(owner, keccak256(abi.encode(keccak256("reject"), id)), pqSignature);
        c.status = Status.Armed;
        c.requestedAt = 0;
        c.requestedBy = address(0);
        emit RequestRejected(id, owner, uint64(block.timestamp));
    }

    /// @notice Owner releases now (for example, approving a pending request at once).
    function releaseNow(address owner, bytes32 id, bytes calldata pqSignature) external {
        Capsule storage c = _live(id);
        if (c.owner != owner) revert NotOwner(id);
        _authorise(owner, keccak256(abi.encode(keccak256("releaseNow"), id)), pqSignature);
        _release(id, c, "owner");
    }

    function cancel(address owner, bytes32 id, bytes calldata pqSignature) external {
        Capsule storage c = _live(id);
        if (c.owner != owner) revert NotOwner(id);
        _authorise(owner, keccak256(abi.encode(keccak256("cancel"), id)), pqSignature);
        c.status = Status.Cancelled;
        emit Cancelled(id, owner, uint64(block.timestamp));
    }

    // ---- guardians ---------------------------------------------------------------------------

    function request(address guardian, bytes32 id, bytes calldata pqSignature) external {
        Capsule storage c = _live(id);
        if (!isGuardian[id][guardian]) revert NotGuardian(id, guardian);
        if (c.mode != Mode.AfterWait) revert WrongState(c.status);
        if (c.status != Status.Armed) revert WrongState(c.status);
        _authorise(guardian, keccak256(abi.encode(keccak256("request"), id)), pqSignature);
        c.status = Status.Requested;
        c.requestedAt = uint64(block.timestamp);
        c.requestedBy = guardian;
        emit ReleaseRequested(id, guardian, uint64(block.timestamp), uint64(block.timestamp) + c.waitSeconds);
    }

    // ---- anyone ------------------------------------------------------------------------------

    /// @notice Record a release whose time has come. Needs no authority: it only writes what is already true.
    function finalize(bytes32 id) external {
        Capsule storage c = _live(id);
        uint64 at = opensAt(id);
        if (at == 0 || block.timestamp < at) revert NotYet(at);
        _release(id, c, c.mode == Mode.AtTime ? bytes32("time") : c.mode == Mode.AfterWait ? bytes32("wait") : bytes32("quiet"));
    }

    // ---- internal ----------------------------------------------------------------------------

    function _live(bytes32 id) internal view returns (Capsule storage c) {
        c = _capsules[id];
        if (c.status == Status.None) revert NoCapsule(id);
        if (c.status != Status.Armed && c.status != Status.Requested) revert WrongState(c.status);
    }

    function _release(bytes32 id, Capsule storage c, bytes32 reason) internal {
        c.status = Status.Released;
        c.releasedAt = uint64(block.timestamp);
        emit Released(id, uint64(block.timestamp), reason);
    }

    function _checkGuardians(address owner, address[] calldata guardians, uint8 threshold) internal pure {
        if (guardians.length == 0 || guardians.length > MAX_GUARDIANS) revert BadPlan();
        if (threshold == 0 || threshold > guardians.length) revert BadPlan();
        for (uint256 i = 0; i < guardians.length; i++) {
            if (guardians[i] == address(0) || guardians[i] == owner) revert BadPlan();
            for (uint256 j = 0; j < i; j++) {
                if (guardians[j] == guardians[i]) revert BadPlan();
            }
        }
    }

    function _storeGuardians(bytes32 id, address[] calldata guardians) internal {
        for (uint256 i = 0; i < guardians.length; i++) {
            _guardians[id].push(guardians[i]);
            isGuardian[id][guardians[i]] = true;
        }
    }
}
