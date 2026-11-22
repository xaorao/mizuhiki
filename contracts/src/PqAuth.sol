// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title PqAuth
/// @notice Authorises an account's actions by its ML-DSA-87 key as registered on QoreChain,
/// checked with the pqcVerify precompile. The EVM sender carries no authority: anyone may relay
/// a signed action, and a stolen classical key cannot produce one.
/// @dev Digest = keccak256(abi.encode(DOMAIN, chainid, this, signer, nonce, actionHash)).
/// Per-signer nonces stop replay; chainid and address(this) stop cross-chain and cross-contract
/// replay. Every precompile return is length-checked: an inactive precompile answers success with
/// empty data (QoreChain docs, developer-guide/evm-precompiles.md).
abstract contract PqAuth {
    address internal constant PQC_VERIFY = address(0x0A01);
    address internal constant PQC_KEY_STATUS = address(0x0A02);
    uint8 internal constant ALG_ML_DSA_87 = 1;
    bytes32 public constant DOMAIN = keccak256("MIZUHIKI_PQ_AUTH_V1");

    mapping(address => uint256) public nonceOf;

    error NoPqKey(address account);
    error PossessionNotProven(address account);
    error BadSignature(address account);

    /// @notice The exact 32 bytes an account signs for its next action.
    function actionDigest(address signer, bytes32 actionHash) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, block.chainid, address(this), signer, nonceOf[signer], actionHash));
    }

    function _pqKey(address account) internal view returns (bytes memory key) {
        (bool ok, bytes memory ret) =
            PQC_KEY_STATUS.staticcall(abi.encodeWithSignature("pqcKeyStatus(address)", account));
        // (bool, uint8, bytes, bool): head 4 words + bytes length word at least.
        if (!ok || ret.length < 160) revert NoPqKey(account);
        (bool registered, uint8 alg, bytes memory pub, bool possessionProven) =
            abi.decode(ret, (bool, uint8, bytes, bool));
        if (!registered || alg != ALG_ML_DSA_87 || pub.length == 0) revert NoPqKey(account);
        if (!possessionProven) revert PossessionNotProven(account);
        return pub;
    }

    /// @dev Checks the signature over the current digest, then consumes the nonce.
    function _authorise(address signer, bytes32 actionHash, bytes calldata pqSignature) internal {
        bytes32 d = actionDigest(signer, actionHash);
        bytes memory pub = _pqKey(signer);
        (bool ok, bytes memory ret) = PQC_VERIFY.staticcall(
            abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pub, pqSignature, abi.encodePacked(d))
        );
        if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) revert BadSignature(signer);
        unchecked {
            nonceOf[signer] += 1;
        }
    }
}
