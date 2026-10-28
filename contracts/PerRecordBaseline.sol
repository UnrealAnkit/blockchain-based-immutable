// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PerRecordBaseline
/// @notice The naive design the project compares against: one transaction and one
///         storage slot per sensor reading. Used only in the cost experiment.
contract PerRecordBaseline {
    mapping(bytes32 => uint64) public anchoredAt;

    event RecordAnchored(address indexed gateway, bytes32 indexed recordHash);

    function anchorRecord(bytes32 recordHash) external {
        anchoredAt[recordHash] = uint64(block.timestamp);
        emit RecordAnchored(msg.sender, recordHash);
    }
}
