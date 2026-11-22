// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PqAuth} from "../src/PqAuth.sol";
import {KeyStatusStandIn, VerifyStandIn} from "./PqStandIn.sol";

abstract contract Base is Test {
    KeyStatusStandIn internal status = KeyStatusStandIn(address(0x0A02));
    VerifyStandIn internal verifier = VerifyStandIn(address(0x0A01));

    mapping(address => bytes32) internal secretOf;
    mapping(address => bytes) internal pubOf;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal relayer = makeAddr("relayer");

    function setUp() public virtual {
        vm.etch(address(0x0A02), type(KeyStatusStandIn).runtimeCode);
        vm.etch(address(0x0A01), type(VerifyStandIn).runtimeCode);
        _key(alice);
        _key(bob);
        _key(carol);
        _key(dave);
    }

    function _key(address a) internal {
        bytes memory pub = abi.encodePacked(keccak256(abi.encode("pub", a)), keccak256(abi.encode("pub2", a)));
        bytes32 secret = keccak256(abi.encode("secret", a));
        pubOf[a] = pub;
        secretOf[a] = secret;
        status.set(a, pub, true, true);
        verifier.setSecret(pub, secret);
    }

    function _sig(PqAuth c, address signer, bytes32 actionHash) internal view returns (bytes memory) {
        bytes32 d = c.actionDigest(signer, actionHash);
        return abi.encodePacked(keccak256(abi.encodePacked(secretOf[signer], abi.encodePacked(d))));
    }

    function _forged(PqAuth c, address victim, bytes32 actionHash, address attacker)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = c.actionDigest(victim, actionHash);
        return abi.encodePacked(keccak256(abi.encodePacked(secretOf[attacker], abi.encodePacked(d))));
    }
}
