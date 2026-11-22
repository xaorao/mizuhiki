// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {PqAuth} from "../src/PqAuth.sol";
import {CapsuleVault} from "../src/CapsuleVault.sol";

contract CapsuleTest is Base {
    CapsuleVault internal v;
    bytes32 internal constant ID = keccak256("cap-1");
    bytes32 internal constant PLAN = keccak256("plan");
    uint64 internal constant ACCESS = 30 days;

    function setUp() public override {
        super.setUp();
        v = new CapsuleVault();
        vm.warp(1_800_000_000);
    }

    function _guardians() internal view returns (address[] memory g) {
        g = new address[](3);
        g[0] = bob;
        g[1] = carol;
        g[2] = dave;
    }

    function _create(CapsuleVault.Mode mode, uint64 releaseAt, uint64 wait, uint64 quiet) internal {
        address[] memory g = _guardians();
        bytes32 a = keccak256(abi.encode(keccak256("create"), ID, mode, g, uint8(2), releaseAt, wait, quiet, ACCESS, PLAN));
        vm.prank(relayer);
        v.create(alice, ID, mode, g, 2, releaseAt, wait, quiet, ACCESS, PLAN, _sig(v, alice, a));
    }

    function _status() internal view returns (CapsuleVault.Status) {
        (CapsuleVault.Capsule memory c,) = v.capsule(ID);
        return c.status;
    }

    function test_at_time_opens_only_after_time() public {
        uint64 at = uint64(vm.getBlockTimestamp() + 10 days);
        _create(CapsuleVault.Mode.AtTime, at, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(CapsuleVault.NotYet.selector, at));
        v.finalize(ID);
        vm.warp(at);
        assertEq(uint8(v.effectiveStatus(ID)), uint8(CapsuleVault.Status.Released));
        v.finalize(ID);
        assertEq(uint8(_status()), uint8(CapsuleVault.Status.Released));
    }

    function test_after_wait_request_reject_cancel() public {
        _create(CapsuleVault.Mode.AfterWait, 0, 7 days, 0);
        assertEq(v.opensAt(ID), 0);
        bytes32 r = keccak256(abi.encode(keccak256("request"), ID));
        v.request(bob, ID, _sig(v, bob, r));
        assertEq(uint8(_status()), uint8(CapsuleVault.Status.Requested));
        assertEq(v.opensAt(ID), uint64(vm.getBlockTimestamp() + 7 days));
        // owner rejects; guardian stays a guardian and may ask again
        v.reject(alice, ID, _sig(v, alice, keccak256(abi.encode(keccak256("reject"), ID))));
        assertEq(uint8(_status()), uint8(CapsuleVault.Status.Armed));
        assertTrue(v.isGuardian(ID, bob));
        v.request(carol, ID, _sig(v, carol, r));
        vm.warp(vm.getBlockTimestamp() + 7 days - 1);
        vm.expectRevert();
        v.finalize(ID);
        vm.warp(vm.getBlockTimestamp() + 1);
        v.finalize(ID);
        assertEq(uint8(_status()), uint8(CapsuleVault.Status.Released));
    }

    function test_owner_cancel_stops_release() public {
        _create(CapsuleVault.Mode.AfterWait, 0, 7 days, 0);
        v.request(bob, ID, _sig(v, bob, keccak256(abi.encode(keccak256("request"), ID))));
        v.cancel(alice, ID, _sig(v, alice, keccak256(abi.encode(keccak256("cancel"), ID))));
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.expectRevert(abi.encodeWithSelector(CapsuleVault.WrongState.selector, CapsuleVault.Status.Cancelled));
        v.finalize(ID);
    }

    function test_non_guardian_cannot_request() public {
        _create(CapsuleVault.Mode.AfterWait, 0, 7 days, 0);
        address eve = makeAddr("eve");
        _key(eve);
        bytes32 r = keccak256(abi.encode(keccak256("request"), ID));
        bytes memory s = _sig(v, eve, r);
        vm.expectRevert(abi.encodeWithSelector(CapsuleVault.NotGuardian.selector, ID, eve));
        v.request(eve, ID, s);
    }

    function test_guardian_forged_by_classical_sender_fails() public {
        _create(CapsuleVault.Mode.AfterWait, 0, 7 days, 0);
        bytes32 r = keccak256(abi.encode(keccak256("request"), ID));
        bytes memory forged = _forged(v, bob, r, dave);
        vm.prank(bob); // even sent from bob's own EVM account, the PQ signature is what counts
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, bob));
        v.request(bob, ID, forged);
    }

    function test_if_quiet_check_in_resets() public {
        _create(CapsuleVault.Mode.IfQuiet, 0, 0, 180 days);
        uint64 first = v.opensAt(ID);
        assertEq(first, uint64(vm.getBlockTimestamp() + 180 days));
        vm.warp(vm.getBlockTimestamp() + 100 days);
        v.checkIn(alice, _sig(v, alice, keccak256(abi.encode(keccak256("checkIn")))));
        assertEq(v.opensAt(ID), uint64(vm.getBlockTimestamp() + 180 days));
        vm.warp(vm.getBlockTimestamp() + 179 days);
        vm.expectRevert();
        v.finalize(ID);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        v.finalize(ID);
        assertEq(uint8(_status()), uint8(CapsuleVault.Status.Released));
    }

    function test_check_in_replay_reverts() public {
        bytes memory s = _sig(v, alice, keccak256(abi.encode(keccak256("checkIn"))));
        v.checkIn(alice, s);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        v.checkIn(alice, s);
    }

    function test_guardian_cannot_cancel_or_release() public {
        _create(CapsuleVault.Mode.AfterWait, 0, 7 days, 0);
        bytes memory s = _sig(v, bob, keccak256(abi.encode(keccak256("releaseNow"), ID)));
        vm.expectRevert(abi.encodeWithSelector(CapsuleVault.NotOwner.selector, ID));
        v.releaseNow(bob, ID, s);
        bytes memory c = _sig(v, bob, keccak256(abi.encode(keccak256("cancel"), ID)));
        vm.expectRevert(abi.encodeWithSelector(CapsuleVault.NotOwner.selector, ID));
        v.cancel(bob, ID, c);
    }

    function test_owner_release_now() public {
        _create(CapsuleVault.Mode.AfterWait, 0, 7 days, 0);
        v.request(bob, ID, _sig(v, bob, keccak256(abi.encode(keccak256("request"), ID))));
        v.releaseNow(alice, ID, _sig(v, alice, keccak256(abi.encode(keccak256("releaseNow"), ID))));
        assertEq(uint8(_status()), uint8(CapsuleVault.Status.Released));
        bytes memory c = _sig(v, alice, keccak256(abi.encode(keccak256("cancel"), ID)));
        vm.expectRevert(abi.encodeWithSelector(CapsuleVault.WrongState.selector, CapsuleVault.Status.Released));
        v.cancel(alice, ID, c);
    }

    function test_replace_guardians() public {
        _create(CapsuleVault.Mode.AfterWait, 0, 7 days, 0);
        address[] memory g = new address[](2);
        g[0] = carol;
        g[1] = dave;
        bytes32 a = keccak256(abi.encode(keccak256("setGuardians"), ID, g, uint8(2), keccak256("plan2")));
        v.setGuardians(alice, ID, g, 2, keccak256("plan2"), _sig(v, alice, a));
        assertFalse(v.isGuardian(ID, bob));
        assertTrue(v.isGuardian(ID, carol));
        bytes memory s = _sig(v, bob, keccak256(abi.encode(keccak256("request"), ID)));
        vm.expectRevert(abi.encodeWithSelector(CapsuleVault.NotGuardian.selector, ID, bob));
        v.request(bob, ID, s);
    }

    function test_bad_plans_rejected() public {
        address[] memory g = _guardians();
        address[] memory dup = new address[](2);
        dup[0] = bob;
        dup[1] = bob;
        address[] memory self = new address[](1);
        self[0] = alice;
        _expectBadPlan(CapsuleVault.Mode.AtTime, g, 2, uint64(vm.getBlockTimestamp()), 0, 0);
        _expectBadPlan(CapsuleVault.Mode.AfterWait, g, 2, 0, 60, 0);
        _expectBadPlan(CapsuleVault.Mode.IfQuiet, g, 2, 0, 0, 3600);
        _expectBadPlan(CapsuleVault.Mode.AfterWait, g, 4, 0, 7 days, 0);
        _expectBadPlan(CapsuleVault.Mode.AfterWait, g, 0, 0, 7 days, 0);
        _expectBadPlan(CapsuleVault.Mode.AfterWait, dup, 1, 0, 7 days, 0);
        _expectBadPlan(CapsuleVault.Mode.AfterWait, self, 1, 0, 7 days, 0);
    }

    function _expectBadPlan(CapsuleVault.Mode m, address[] memory g, uint8 t, uint64 at, uint64 w, uint64 q) internal {
        vm.expectRevert(CapsuleVault.BadPlan.selector);
        v.create(alice, ID, m, g, t, at, w, q, ACCESS, PLAN, hex"00");
    }

    function test_create_twice_reverts() public {
        _create(CapsuleVault.Mode.AfterWait, 0, 7 days, 0);
        address[] memory g = _guardians();
        vm.expectRevert(abi.encodeWithSelector(CapsuleVault.CapsuleExists.selector, ID));
        v.create(alice, ID, CapsuleVault.Mode.AfterWait, g, 2, 0, 7 days, 0, ACCESS, PLAN, hex"00");
    }
}
