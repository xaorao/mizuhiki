// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {PqAuth} from "./PqAuth.sol";

/// @title MizuhikiRegistry
/// @notice Public records of Mizuhiki: names, recipient cards, proof anchors, room epochs and roles,
/// and publication records (forms, products, passes). Every write is authorised by the acting
/// account's ML-DSA-87 key (see PqAuth); all state is mirrored in events for eth_getLogs.
contract MizuhikiRegistry is PqAuth {
    // ---- names ----------------------------------------------------------------------------
    uint256 public constant MIN_NAME = 3;
    uint256 public constant MAX_NAME = 30;

    mapping(bytes32 => address) public ownerOfName; // keccak256(name) => owner
    mapping(address => bytes32) public primaryName; // owner => keccak256(name)
    mapping(address => bytes32) public cardHashOf;

    event NameClaimed(bytes32 indexed nameHash, address indexed owner, string name, bool primary);
    event NameReleased(bytes32 indexed nameHash, address indexed owner, string name);
    event PrimaryNameSet(address indexed owner, bytes32 indexed nameHash);
    event CardSet(address indexed owner, bytes32 cardHash);

    /// @dev Commit then reveal, so a watcher of pending transactions cannot claim a name first.
    uint64 public constant MAX_COMMIT_BLOCKS = 66_000; // about a day at 1.3 s blocks
    mapping(bytes32 => uint64) public commitBlock;

    event Committed(bytes32 indexed commitment, uint64 blockNumber);

    error InvalidName();
    error NoCommitment();
    error NameTaken(bytes32 nameHash);
    error NotNameOwner(bytes32 nameHash);

    // ---- anchors --------------------------------------------------------------------------
    struct Anchor {
        address by;
        uint64 at;
        uint64 blockNumber;
        bytes32 kind;
    }

    mapping(bytes32 => Anchor) internal _anchors;

    event Anchored(bytes32 indexed contentHash, address indexed by, bytes32 indexed kind, uint64 at);

    error AlreadyAnchored(bytes32 contentHash);

    // ---- rooms ----------------------------------------------------------------------------
    uint8 public constant ROLE_NONE = 0;
    uint8 public constant ROLE_MEMBER = 1;
    uint8 public constant ROLE_ADMIN = 2;
    uint8 public constant ROLE_OWNER = 3;

    struct Room {
        address owner;
        uint64 epoch;
        bytes32 membershipHash;
        bytes32 distributionHash;
        bool closed;
    }

    mapping(bytes32 => Room) public rooms;
    mapping(bytes32 => mapping(address => uint8)) public roleOf;

    event RoomCreated(bytes32 indexed roomId, address indexed owner, bytes32 membershipHash, bytes32 distributionHash);
    event RoomEpoch(
        bytes32 indexed roomId, uint64 indexed epoch, address indexed by, bytes32 membershipHash, bytes32 distributionHash, bytes32 reason
    );
    event RoomRole(bytes32 indexed roomId, address indexed member, uint8 role, address by);
    event RoomClosed(bytes32 indexed roomId, address indexed by);

    error RoomExists(bytes32 roomId);
    error NoRoom(bytes32 roomId);
    error NotRoomAdmin(bytes32 roomId, address account);
    error StaleEpoch(uint64 expected, uint64 given);
    error BadRole();

    // ---- publications ---------------------------------------------------------------------
    event Published(address indexed owner, bytes32 indexed kind, bytes32 indexed id, bytes32 contentHash, bool active);

    // =======================================================================================
    // names
    // =======================================================================================

    /// @notice Lowercase a-z, 0-9, "." "_" "-", 3 to 30 bytes, starting and ending with a letter or digit.
    function isValidName(string memory name) public pure returns (bool) {
        bytes memory b = bytes(name);
        if (b.length < MIN_NAME || b.length > MAX_NAME) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool alnum = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
            bool punct = c == 0x2e || c == 0x5f || c == 0x2d;
            if (!alnum && !punct) return false;
            if (punct && (i == 0 || i == b.length - 1)) return false;
        }
        return true;
    }

    /// @notice commitment = keccak256(abi.encode(name, owner, secret)). Anyone may submit it.
    function commit(bytes32 commitment) external {
        commitBlock[commitment] = uint64(block.number);
        emit Committed(commitment, uint64(block.number));
    }

    function _consumeCommitment(string calldata name, address owner, bytes32 secret) internal {
        bytes32 c = keccak256(abi.encode(name, owner, secret));
        uint64 at = commitBlock[c];
        if (at == 0 || block.number <= at || block.number > uint256(at) + MAX_COMMIT_BLOCKS) revert NoCommitment();
        delete commitBlock[c];
    }

    function claimName(address owner, string calldata name, bool makePrimary, bytes32 secret, bytes calldata pqSignature) external {
        if (!isValidName(name)) revert InvalidName();
        bytes32 h = keccak256(bytes(name));
        if (ownerOfName[h] != address(0)) revert NameTaken(h);
        _consumeCommitment(name, owner, secret);
        _authorise(owner, keccak256(abi.encode(keccak256("claimName"), h, makePrimary)), pqSignature);
        ownerOfName[h] = owner;
        bool primary = makePrimary || primaryName[owner] == bytes32(0);
        if (primary) primaryName[owner] = h;
        emit NameClaimed(h, owner, name, primary);
        if (primary) emit PrimaryNameSet(owner, h);
    }

    function releaseName(address owner, string calldata name, bytes calldata pqSignature) external {
        bytes32 h = keccak256(bytes(name));
        if (ownerOfName[h] != owner) revert NotNameOwner(h);
        _authorise(owner, keccak256(abi.encode(keccak256("releaseName"), h)), pqSignature);
        delete ownerOfName[h];
        if (primaryName[owner] == h) {
            delete primaryName[owner];
            emit PrimaryNameSet(owner, bytes32(0));
        }
        emit NameReleased(h, owner, name);
    }

    function setPrimaryName(address owner, string calldata name, bytes calldata pqSignature) external {
        bytes32 h = keccak256(bytes(name));
        if (ownerOfName[h] != owner) revert NotNameOwner(h);
        _authorise(owner, keccak256(abi.encode(keccak256("setPrimaryName"), h)), pqSignature);
        primaryName[owner] = h;
        emit PrimaryNameSet(owner, h);
    }

    function setCard(address owner, bytes32 cardHash, bytes calldata pqSignature) external {
        _authorise(owner, keccak256(abi.encode(keccak256("setCard"), cardHash)), pqSignature);
        cardHashOf[owner] = cardHash;
        emit CardSet(owner, cardHash);
    }

    /// @notice Sign-up in one transaction: card plus first name.
    function register(address owner, string calldata name, bytes32 cardHash, bytes32 secret, bytes calldata pqSignature)
        external
    {
        if (!isValidName(name)) revert InvalidName();
        bytes32 h = keccak256(bytes(name));
        if (ownerOfName[h] != address(0)) revert NameTaken(h);
        _consumeCommitment(name, owner, secret);
        _authorise(owner, keccak256(abi.encode(keccak256("register"), h, cardHash)), pqSignature);
        ownerOfName[h] = owner;
        cardHashOf[owner] = cardHash;
        bool primary = primaryName[owner] == bytes32(0);
        if (primary) primaryName[owner] = h;
        emit CardSet(owner, cardHash);
        emit NameClaimed(h, owner, name, primary);
        if (primary) emit PrimaryNameSet(owner, h);
    }

    function resolve(string calldata name) external view returns (address owner, bytes32 cardHash) {
        owner = ownerOfName[keccak256(bytes(name))];
        cardHash = cardHashOf[owner];
    }

    // =======================================================================================
    // anchors (proof that a document existed, without revealing it)
    // =======================================================================================

    function anchor(address by, bytes32 contentHash, bytes32 kind, bytes calldata pqSignature) external {
        if (_anchors[contentHash].at != 0) revert AlreadyAnchored(contentHash);
        _authorise(by, keccak256(abi.encode(keccak256("anchor"), contentHash, kind)), pqSignature);
        _anchors[contentHash] = Anchor({by: by, at: uint64(block.timestamp), blockNumber: uint64(block.number), kind: kind});
        emit Anchored(contentHash, by, kind, uint64(block.timestamp));
    }

    function anchorOf(bytes32 contentHash) external view returns (address by, uint64 at, uint64 blockNumber, bytes32 kind) {
        Anchor memory a = _anchors[contentHash];
        return (a.by, a.at, a.blockNumber, a.kind);
    }

    // =======================================================================================
    // rooms
    // =======================================================================================

    function createRoom(address owner, bytes32 roomId, bytes32 membershipHash, bytes32 distributionHash, bytes calldata pqSignature)
        external
    {
        if (rooms[roomId].owner != address(0)) revert RoomExists(roomId);
        _authorise(owner, keccak256(abi.encode(keccak256("createRoom"), roomId, membershipHash, distributionHash)), pqSignature);
        rooms[roomId] = Room({owner: owner, epoch: 1, membershipHash: membershipHash, distributionHash: distributionHash, closed: false});
        roleOf[roomId][owner] = ROLE_OWNER;
        emit RoomCreated(roomId, owner, membershipHash, distributionHash);
        emit RoomRole(roomId, owner, ROLE_OWNER, owner);
        emit RoomEpoch(roomId, 1, owner, membershipHash, distributionHash, "created");
    }

    function _requireAdmin(bytes32 roomId, address actor) internal view returns (Room storage r) {
        r = rooms[roomId];
        if (r.owner == address(0) || r.closed) revert NoRoom(roomId);
        if (roleOf[roomId][actor] < ROLE_ADMIN) revert NotRoomAdmin(roomId, actor);
    }

    /// @notice Record a key rotation: `newEpoch` must be exactly the next epoch, so two admins
    /// racing cannot both win; the later one sees StaleEpoch and rebases.
    function rotateRoom(
        address actor,
        bytes32 roomId,
        uint64 newEpoch,
        bytes32 membershipHash,
        bytes32 distributionHash,
        bytes32 reason,
        bytes calldata pqSignature
    ) external {
        Room storage r = _requireAdmin(roomId, actor);
        if (newEpoch != r.epoch + 1) revert StaleEpoch(r.epoch + 1, newEpoch);
        _authorise(
            actor,
            keccak256(abi.encode(keccak256("rotateRoom"), roomId, newEpoch, membershipHash, distributionHash, reason)),
            pqSignature
        );
        r.epoch = newEpoch;
        r.membershipHash = membershipHash;
        r.distributionHash = distributionHash;
        emit RoomEpoch(roomId, newEpoch, actor, membershipHash, distributionHash, reason);
    }

    /// @notice Set a member's role. Only the owner may grant or remove admin; the owner role
    /// moves only through transferRoom.
    function setRole(address actor, bytes32 roomId, address member, uint8 role, bytes calldata pqSignature) external {
        Room storage r = _requireAdmin(roomId, actor);
        if (role > ROLE_ADMIN || member == r.owner) revert BadRole();
        uint8 current = roleOf[roomId][member];
        if ((role == ROLE_ADMIN || current == ROLE_ADMIN) && actor != r.owner) revert NotRoomAdmin(roomId, actor);
        _authorise(actor, keccak256(abi.encode(keccak256("setRole"), roomId, member, role)), pqSignature);
        roleOf[roomId][member] = role;
        emit RoomRole(roomId, member, role, actor);
    }

    function transferRoom(address owner, bytes32 roomId, address newOwner, bytes calldata pqSignature) external {
        Room storage r = rooms[roomId];
        if (r.owner == address(0) || r.closed) revert NoRoom(roomId);
        if (r.owner != owner) revert NotRoomAdmin(roomId, owner);
        if (newOwner == address(0) || newOwner == owner) revert BadRole();
        _authorise(owner, keccak256(abi.encode(keccak256("transferRoom"), roomId, newOwner)), pqSignature);
        r.owner = newOwner;
        roleOf[roomId][newOwner] = ROLE_OWNER;
        roleOf[roomId][owner] = ROLE_ADMIN;
        emit RoomRole(roomId, newOwner, ROLE_OWNER, owner);
        emit RoomRole(roomId, owner, ROLE_ADMIN, owner);
    }

    function closeRoom(address owner, bytes32 roomId, bytes calldata pqSignature) external {
        Room storage r = rooms[roomId];
        if (r.owner == address(0) || r.closed) revert NoRoom(roomId);
        if (r.owner != owner) revert NotRoomAdmin(roomId, owner);
        _authorise(owner, keccak256(abi.encode(keccak256("closeRoom"), roomId)), pqSignature);
        r.closed = true;
        emit RoomClosed(roomId, owner);
    }

    // =======================================================================================
    // publications: forms, products, passes, invoices (hash only)
    // =======================================================================================

    function publish(address owner, bytes32 kind, bytes32 id, bytes32 contentHash, bool active, bytes calldata pqSignature) external {
        _authorise(owner, keccak256(abi.encode(keccak256("publish"), kind, id, contentHash, active)), pqSignature);
        emit Published(owner, kind, id, contentHash, active);
    }
}
