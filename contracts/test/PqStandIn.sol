// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @dev Test stand-ins for QoreChain's PQC precompiles, which the local EVM does not have. They
/// keep the real ABI. A "signature" is keccak256(secret, message) for a per-key secret only the test
/// account knows, so wrong-signer, changed-message and replay cases behave as with ML-DSA-87.
/// Real ML-DSA-87 signatures are exercised against the deployed contracts on testnet.
contract KeyStatusStandIn {
    struct Entry {
        bool registered;
        bool proven;
        bytes key;
    }

    mapping(address => Entry) internal entries;

    function set(address a, bytes calldata key, bool registered, bool proven) external {
        entries[a] = Entry(registered, proven, key);
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        address a = abi.decode(data[4:], (address));
        Entry storage e = entries[a];
        return abi.encode(e.registered, e.registered ? uint8(1) : uint8(0), e.key, e.proven);
    }
}

contract VerifyStandIn {
    mapping(bytes32 => bytes32) internal secretOf;

    function setSecret(bytes calldata pub, bytes32 secret) external {
        secretOf[keccak256(pub)] = secret;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        (bytes memory pub, bytes memory sig, bytes memory message) = abi.decode(data[4:], (bytes, bytes, bytes));
        bytes32 s = secretOf[keccak256(pub)];
        bool ok = s != bytes32(0) && sig.length == 32 && bytes32(sig) == keccak256(abi.encodePacked(s, message));
        return abi.encode(ok);
    }
}
