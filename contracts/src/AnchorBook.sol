// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {PqAuth} from "./PqAuth.sol";

/// @title AnchorBook
/// @notice Proof that a document existed, without revealing it: an account records a document's
/// fingerprint, authorised by its ML-DSA-87 key on QoreChain. Every account keeps its own record for
/// a fingerprint, so nobody can block or take over anyone else's (security review M2: in the first
/// version one anchor per fingerprint won, and anyone who learned a fingerprint could anchor it first
/// and make the author's own anchor fail). A record proves the account had the document at that time;
/// it does not prove who wrote it, and the product says so.
contract AnchorBook is PqAuth {
    struct Anchor {
        uint64 at;
        uint64 blockNumber;
        bytes32 kind;
    }

    mapping(bytes32 => mapping(address => Anchor)) internal _anchors;
    mapping(bytes32 => address[]) internal _anchorers;

    error AlreadyAnchored(bytes32 contentHash, address by);

    event Anchored(bytes32 indexed contentHash, address indexed by, bytes32 indexed kind, uint64 at);

    /// @notice Record that `by` had the document with this fingerprint now. Anyone may relay it;
    /// the authority is `by`'s ML-DSA signature over the action and its current nonce.
    function anchor(address by, bytes32 contentHash, bytes32 kind, bytes calldata pqSignature) external {
        if (_anchors[contentHash][by].at != 0) revert AlreadyAnchored(contentHash, by);
        _authorise(by, keccak256(abi.encode(keccak256("anchor"), contentHash, kind)), pqSignature);
        _anchors[contentHash][by] = Anchor({at: uint64(block.timestamp), blockNumber: uint64(block.number), kind: kind});
        _anchorers[contentHash].push(by);
        emit Anchored(contentHash, by, kind, uint64(block.timestamp));
    }

    /// @notice One account's record for a fingerprint (at == 0: none).
    function anchorOf(bytes32 contentHash, address by)
        external
        view
        returns (uint64 at, uint64 blockNumber, bytes32 kind)
    {
        Anchor memory a = _anchors[contentHash][by];
        return (a.at, a.blockNumber, a.kind);
    }

    /// @notice How many accounts recorded this fingerprint.
    function anchorCount(bytes32 contentHash) external view returns (uint256) {
        return _anchorers[contentHash].length;
    }

    /// @notice Records in the order they were made, one page at a time (`offset`, at most `limit`).
    function anchorsOf(bytes32 contentHash, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory by, uint64[] memory at, uint64[] memory blockNumber, bytes32[] memory kind)
    {
        address[] storage all = _anchorers[contentHash];
        uint256 end = offset >= all.length ? offset : (all.length - offset < limit ? all.length : offset + limit);
        uint256 n = end - offset;
        by = new address[](n);
        at = new uint64[](n);
        blockNumber = new uint64[](n);
        kind = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            address a = all[offset + i];
            Anchor memory r = _anchors[contentHash][a];
            (by[i], at[i], blockNumber[i], kind[i]) = (a, r.at, r.blockNumber, r.kind);
        }
    }
}
