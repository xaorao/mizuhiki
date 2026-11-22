// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {PqAuth} from "../src/PqAuth.sol";
import {MizuhikiRegistry} from "../src/MizuhikiRegistry.sol";

contract RegistryTest is Base {
    MizuhikiRegistry internal reg;
    bytes32 internal constant CARD = keccak256("card");
    bytes32 internal constant SECRET = keccak256("s");

    function setUp() public override {
        super.setUp();
        reg = new MizuhikiRegistry();
    }

    function _commit(string memory name, address owner) internal {
        reg.commit(keccak256(abi.encode(name, owner, SECRET)));
        vm.roll(block.number + 1);
    }

    function _register(address owner, string memory name) internal {
        _commit(name, owner);
        bytes32 a = keccak256(abi.encode(keccak256("register"), keccak256(bytes(name)), CARD));
        vm.prank(relayer);
        reg.register(owner, name, CARD, SECRET, _sig(reg, owner, a));
    }

    function test_register_relayed() public {
        _register(alice, "aria");
        (address o, bytes32 c) = reg.resolve("aria");
        assertEq(o, alice);
        assertEq(c, CARD);
        assertEq(reg.primaryName(alice), keccak256("aria"));
        assertEq(reg.nonceOf(alice), 1);
    }

    function test_names_rules() public view {
        assertTrue(reg.isValidName("aria"));
        assertTrue(reg.isValidName("north.studio"));
        assertTrue(reg.isValidName("a_b-c"));
        assertFalse(reg.isValidName("ab"));
        assertFalse(reg.isValidName("Aria"));
        assertFalse(reg.isValidName(".aria"));
        assertFalse(reg.isValidName("aria-"));
        assertFalse(reg.isValidName("ar ia"));
        assertFalse(reg.isValidName("abcdefghijabcdefghijabcdefghija"));
    }

    function test_register_needs_prior_commitment() public {
        bytes32 a = keccak256(abi.encode(keccak256("register"), keccak256("aria"), CARD));
        bytes memory s = _sig(reg, alice, a);
        vm.expectRevert(MizuhikiRegistry.NoCommitment.selector);
        reg.register(alice, "aria", CARD, SECRET, s);
        // a commitment in the same block is not enough
        reg.commit(keccak256(abi.encode("aria", alice, SECRET)));
        vm.expectRevert(MizuhikiRegistry.NoCommitment.selector);
        reg.register(alice, "aria", CARD, SECRET, s);
    }

    function test_frontrunner_cannot_take_name() public {
        _commit("aria", alice);
        // bob saw the reveal and tries in the same block with his own fresh commitment
        reg.commit(keccak256(abi.encode("aria", bob, SECRET)));
        bytes32 a = keccak256(abi.encode(keccak256("register"), keccak256("aria"), CARD));
        bytes memory sb = _sig(reg, bob, a);
        vm.expectRevert(MizuhikiRegistry.NoCommitment.selector);
        reg.register(bob, "aria", CARD, SECRET, sb);
        reg.register(alice, "aria", CARD, SECRET, _sig(reg, alice, a));
        (address o,) = reg.resolve("aria");
        assertEq(o, alice);
    }

    /// Security review (2026-11-21): re-submitting someone's live commitment in the block of their reveal used to
    /// reset its block and make the reveal fail. A live commitment now keeps its block.
    function test_recommitting_a_live_commitment_cannot_block_the_reveal() public {
        _commit("aria", alice);
        bytes32 c = keccak256(abi.encode("aria", alice, SECRET));
        vm.prank(bob);
        reg.commit(c); // the griefer, in the same block as the reveal
        assertEq(reg.commitBlock(c), uint64(block.number - 1));
        bytes32 a = keccak256(abi.encode(keccak256("register"), keccak256("aria"), CARD));
        reg.register(alice, "aria", CARD, SECRET, _sig(reg, alice, a));
        (address o,) = reg.resolve("aria");
        assertEq(o, alice);
    }

    function test_an_expired_commitment_can_be_made_again() public {
        bytes32 c = keccak256(abi.encode("aria", alice, SECRET));
        reg.commit(c);
        vm.roll(block.number + reg.MAX_COMMIT_BLOCKS() + 2);
        reg.commit(c);
        assertEq(reg.commitBlock(c), uint64(block.number));
        vm.roll(block.number + 1);
        bytes32 a = keccak256(abi.encode(keccak256("register"), keccak256("aria"), CARD));
        reg.register(alice, "aria", CARD, SECRET, _sig(reg, alice, a));
    }

    function test_bad_signature_reverts() public {
        _commit("aria", alice);
        bytes32 a = keccak256(abi.encode(keccak256("register"), keccak256("aria"), CARD));
        bytes memory bad = _forged(reg, alice, a, bob);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        reg.register(alice, "aria", CARD, SECRET, bad);
    }

    function test_signature_for_other_action_reverts() public {
        _commit("aria", alice);
        bytes32 other = keccak256(abi.encode(keccak256("register"), keccak256("mila"), CARD));
        bytes memory s = _sig(reg, alice, other);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        reg.register(alice, "aria", CARD, SECRET, s);
    }

    function test_replay_reverts() public {
        bytes32 a = keccak256(abi.encode(keccak256("setCard"), CARD));
        bytes memory s = _sig(reg, alice, a);
        reg.setCard(alice, CARD, s);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        reg.setCard(alice, CARD, s);
    }

    function test_cross_contract_replay_reverts() public {
        MizuhikiRegistry other = new MizuhikiRegistry();
        bytes32 a = keccak256(abi.encode(keccak256("setCard"), CARD));
        bytes memory s = _sig(reg, alice, a);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        other.setCard(alice, CARD, s);
    }

    function test_cross_chain_replay_reverts() public {
        bytes32 a = keccak256(abi.encode(keccak256("setCard"), CARD));
        bytes memory s = _sig(reg, alice, a);
        vm.chainId(9801);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        reg.setCard(alice, CARD, s);
    }

    function test_unregistered_or_unproven_key_reverts() public {
        address eve = makeAddr("eve");
        vm.expectRevert(abi.encodeWithSelector(PqAuth.NoPqKey.selector, eve));
        reg.setCard(eve, CARD, hex"00");
        status.set(eve, hex"1234", true, false);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.PossessionNotProven.selector, eve));
        reg.setCard(eve, CARD, hex"00");
    }

    function test_inactive_precompile_reverts() public {
        vm.etch(address(0x0A02), hex"");
        vm.expectRevert(abi.encodeWithSelector(PqAuth.NoPqKey.selector, alice));
        reg.setCard(alice, CARD, hex"00");
    }

    function test_name_taken_and_release() public {
        _register(alice, "aria");
        _commit("aria", bob);
        bytes32 a = keccak256(abi.encode(keccak256("register"), keccak256("aria"), CARD));
        bytes memory s = _sig(reg, bob, a);
        vm.expectRevert(abi.encodeWithSelector(MizuhikiRegistry.NameTaken.selector, keccak256("aria")));
        reg.register(bob, "aria", CARD, SECRET, s);
        // bob cannot release alice's name even with his own valid signature
        bytes32 r = keccak256(abi.encode(keccak256("releaseName"), keccak256("aria")));
        bytes memory sr = _sig(reg, bob, r);
        vm.expectRevert(abi.encodeWithSelector(MizuhikiRegistry.NotNameOwner.selector, keccak256("aria")));
        reg.releaseName(bob, "aria", sr);
        reg.releaseName(alice, "aria", _sig(reg, alice, r));
        (address o,) = reg.resolve("aria");
        assertEq(o, address(0));
        assertEq(reg.primaryName(alice), bytes32(0));
    }

    function test_second_name_and_primary() public {
        _register(alice, "aria");
        _commit("aria.studio", alice);
        bytes32 a = keccak256(abi.encode(keccak256("claimName"), keccak256("aria.studio"), false));
        reg.claimName(alice, "aria.studio", false, SECRET, _sig(reg, alice, a));
        assertEq(reg.primaryName(alice), keccak256("aria"));
        bytes32 p = keccak256(abi.encode(keccak256("setPrimaryName"), keccak256("aria.studio")));
        reg.setPrimaryName(alice, "aria.studio", _sig(reg, alice, p));
        assertEq(reg.primaryName(alice), keccak256("aria.studio"));
    }

    function test_anchor_once() public {
        bytes32 h = keccak256("contract.pdf");
        bytes32 a = keccak256(abi.encode(keccak256("anchor"), h, bytes32("file")));
        reg.anchor(alice, h, "file", _sig(reg, alice, a));
        (address by, uint64 at,, bytes32 kind) = reg.anchorOf(h);
        assertEq(by, alice);
        assertEq(at, uint64(block.timestamp));
        assertEq(kind, bytes32("file"));
        bytes memory s2 = _sig(reg, bob, keccak256(abi.encode(keccak256("anchor"), h, bytes32("file"))));
        vm.expectRevert(abi.encodeWithSelector(MizuhikiRegistry.AlreadyAnchored.selector, h));
        reg.anchor(bob, h, "file", s2);
    }

    // ---- rooms ----
    bytes32 internal constant ROOM = keccak256("room-1");

    function _createRoom() internal {
        bytes32 a = keccak256(abi.encode(keccak256("createRoom"), ROOM, bytes32("m1"), bytes32("d1")));
        reg.createRoom(alice, ROOM, "m1", "d1", _sig(reg, alice, a));
    }

    function _rotate(address actor, uint64 epoch, bytes32 m) internal {
        bytes32 a = keccak256(abi.encode(keccak256("rotateRoom"), ROOM, epoch, m, bytes32("d"), bytes32("removed")));
        reg.rotateRoom(actor, ROOM, epoch, m, "d", "removed", _sig(reg, actor, a));
    }

    function _role(address actor, address member, uint8 role) internal {
        bytes32 a = keccak256(abi.encode(keccak256("setRole"), ROOM, member, role));
        reg.setRole(actor, ROOM, member, role, _sig(reg, actor, a));
    }

    function test_room_rotation_by_owner_and_admin() public {
        _createRoom();
        (, uint64 e,,,) = reg.rooms(ROOM);
        assertEq(e, 1);
        _rotate(alice, 2, "m2");
        _role(alice, bob, 2);
        _rotate(bob, 3, "m3");
        (, uint64 e3, bytes32 m3,,) = reg.rooms(ROOM);
        assertEq(e3, 3);
        assertEq(m3, bytes32("m3"));
    }

    function test_room_member_cannot_rotate_or_promote() public {
        _createRoom();
        _role(alice, bob, 1);
        bytes32 a =
            keccak256(abi.encode(keccak256("rotateRoom"), ROOM, uint64(2), bytes32("m"), bytes32("d"), bytes32("x")));
        bytes memory s = _sig(reg, bob, a);
        vm.expectRevert(abi.encodeWithSelector(MizuhikiRegistry.NotRoomAdmin.selector, ROOM, bob));
        reg.rotateRoom(bob, ROOM, 2, "m", "d", "x", s);
    }

    function test_admin_cannot_make_or_remove_admins() public {
        _createRoom();
        _role(alice, bob, 2);
        bytes32 a = keccak256(abi.encode(keccak256("setRole"), ROOM, carol, uint8(2)));
        bytes memory s = _sig(reg, bob, a);
        vm.expectRevert(abi.encodeWithSelector(MizuhikiRegistry.NotRoomAdmin.selector, ROOM, bob));
        reg.setRole(bob, ROOM, carol, 2, s);
        // admin may add and remove plain members
        _role(bob, carol, 1);
        _role(bob, carol, 0);
        assertEq(reg.roleOf(ROOM, carol), 0);
    }

    function test_stale_epoch_reverts() public {
        _createRoom();
        _rotate(alice, 2, "m2");
        bytes32 a = keccak256(
            abi.encode(keccak256("rotateRoom"), ROOM, uint64(2), bytes32("m"), bytes32("d"), bytes32("removed"))
        );
        bytes memory s = _sig(reg, alice, a);
        vm.expectRevert(abi.encodeWithSelector(MizuhikiRegistry.StaleEpoch.selector, uint64(3), uint64(2)));
        reg.rotateRoom(alice, ROOM, 2, "m", "d", "removed", s);
    }

    function test_transfer_and_close_room() public {
        _createRoom();
        bytes32 t = keccak256(abi.encode(keccak256("transferRoom"), ROOM, bob));
        reg.transferRoom(alice, ROOM, bob, _sig(reg, alice, t));
        assertEq(reg.roleOf(ROOM, bob), 3);
        assertEq(reg.roleOf(ROOM, alice), 2);
        bytes32 c = keccak256(abi.encode(keccak256("closeRoom"), ROOM));
        bytes memory sa = _sig(reg, alice, c);
        vm.expectRevert(abi.encodeWithSelector(MizuhikiRegistry.NotRoomAdmin.selector, ROOM, alice));
        reg.closeRoom(alice, ROOM, sa);
        reg.closeRoom(bob, ROOM, _sig(reg, bob, c));
        bytes32 a =
            keccak256(abi.encode(keccak256("rotateRoom"), ROOM, uint64(2), bytes32("m"), bytes32("d"), bytes32("x")));
        bytes memory sr = _sig(reg, bob, a);
        vm.expectRevert(abi.encodeWithSelector(MizuhikiRegistry.NoRoom.selector, ROOM));
        reg.rotateRoom(bob, ROOM, 2, "m", "d", "x", sr);
    }

    function test_publish_emits() public {
        bytes32 a = keccak256(abi.encode(keccak256("publish"), bytes32("form"), bytes32("f1"), bytes32("h"), true));
        vm.expectEmit(true, true, true, true);
        emit MizuhikiRegistry.Published(alice, "form", "f1", "h", true);
        reg.publish(alice, "form", "f1", "h", true, _sig(reg, alice, a));
    }
}
