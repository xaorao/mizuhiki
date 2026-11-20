// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AnchorBook} from "../src/AnchorBook.sol";
import {PqAuth} from "../src/PqAuth.sol";

contract AnchorBookTest is Base {
    AnchorBook internal book;
    bytes32 internal constant H = keccak256("a contract, version 3");

    function setUp() public override {
        super.setUp();
        book = new AnchorBook();
    }

    function _action(bytes32 h, bytes32 kind) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("anchor"), h, kind));
    }

    function test_records_and_reads_back() public {
        vm.warp(1_800_000_000);
        vm.prank(relayer);
        book.anchor(alice, H, "document", _sig(book, alice, _action(H, "document")));
        (uint64 at, uint64 blockNumber, bytes32 kind) = book.anchorOf(H, alice);
        assertEq(at, 1_800_000_000);
        assertEq(blockNumber, uint64(block.number));
        assertEq(kind, bytes32("document"));
        assertEq(book.anchorCount(H), 1);
    }

    /// The review's M2 case: someone who learned the fingerprint anchors it first. The author's own
    /// anchor still goes through, and both records stand, in order.
    function test_a_front_runner_cannot_block_the_author() public {
        vm.warp(100);
        book.anchor(bob, H, "document", _sig(book, bob, _action(H, "document")));
        vm.warp(105);
        book.anchor(alice, H, "document", _sig(book, alice, _action(H, "document")));
        (address[] memory by, uint64[] memory at,,) = book.anchorsOf(H, 0, 10);
        assertEq(by.length, 2);
        assertEq(by[0], bob);
        assertEq(by[1], alice);
        assertEq(at[0], 100);
        assertEq(at[1], 105);
        (uint64 aliceAt,,) = book.anchorOf(H, alice);
        assertEq(aliceAt, 105);
    }

    function test_the_same_account_records_a_fingerprint_once() public {
        book.anchor(alice, H, "document", _sig(book, alice, _action(H, "document")));
        bytes memory again = _sig(book, alice, _action(H, "document"));
        vm.expectRevert(abi.encodeWithSelector(AnchorBook.AlreadyAnchored.selector, H, alice));
        book.anchor(alice, H, "document", again);
    }

    function test_only_the_account_itself_can_anchor_for_it() public {
        bytes memory forged = _forged(book, alice, _action(H, "document"), bob);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        book.anchor(alice, H, "document", forged);
        // A signature for another fingerprint or kind does not carry over.
        bytes memory other = _sig(book, alice, _action(keccak256("other"), "document"));
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        book.anchor(alice, H, "document", other);
        bytes memory otherKind = _sig(book, alice, _action(H, "photo"));
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        book.anchor(alice, H, "document", otherKind);
    }

    function test_a_signature_is_used_once() public {
        bytes32 h2 = keccak256("second");
        bytes memory s = _sig(book, alice, _action(H, "document"));
        book.anchor(alice, H, "document", s);
        // Same bytes replayed on another fingerprint: the nonce moved, so it no longer verifies.
        vm.expectRevert(abi.encodeWithSelector(PqAuth.BadSignature.selector, alice));
        book.anchor(alice, h2, "document", s);
    }

    function test_unregistered_or_unproven_keys_are_refused() public {
        address eve = makeAddr("eve");
        vm.expectRevert(abi.encodeWithSelector(PqAuth.NoPqKey.selector, eve));
        book.anchor(eve, H, "document", hex"00");
        status.set(dave, pubOf[dave], true, false);
        bytes memory s = _sig(book, dave, _action(H, "document"));
        vm.expectRevert(abi.encodeWithSelector(PqAuth.PossessionNotProven.selector, dave));
        book.anchor(dave, H, "document", s);
    }

    function test_pages_through_many_records() public {
        address[4] memory who = [alice, bob, carol, dave];
        for (uint256 i = 0; i < who.length; i++) {
            book.anchor(who[i], H, "document", _sig(book, who[i], _action(H, "document")));
        }
        (address[] memory p1,,,) = book.anchorsOf(H, 0, 3);
        (address[] memory p2,,,) = book.anchorsOf(H, 3, 3);
        (address[] memory p3,,,) = book.anchorsOf(H, 9, 3);
        assertEq(p1.length, 3);
        assertEq(p2.length, 1);
        assertEq(p2[0], dave);
        assertEq(p3.length, 0);
        assertEq(book.anchorCount(H), 4);
    }
}
