// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IoTAnchor
/// @notice Stores one compact commitment per batch of IoT readings:
///         the Merkle root of the batch, the SHA-256 digest of the off-chain
///         batch object (the digest inside its IPFS CID), and the range of
///         gateway sequence numbers it covers.
/// @dev    Only registered gateways can anchor. Each gateway's batches must
///         cover a gap-free run of sequence numbers starting at 0, so a batch
///         that is later deleted off-chain still leaves a visible hole.
contract IoTAnchor {
    struct Batch {
        bytes32 root;           // RFC 6962-style SHA-256 Merkle root of the batch
        bytes32 manifestDigest; // SHA-256 of the off-chain batch object
        uint64 firstSeq;        // first gateway sequence number in the batch
        uint64 lastSeq;         // last sequence number (count = lastSeq - firstSeq + 1)
        uint64 anchoredAt;      // block timestamp when anchored
    }

    address public owner;
    mapping(address => bool) public isGateway;
    mapping(address => uint64) public nextSeq;
    mapping(address => Batch[]) private _batches;

    event GatewaySet(address indexed gateway, bool active);
    event BatchAnchored(
        address indexed gateway,
        uint256 indexed batchNo,
        bytes32 root,
        bytes32 manifestDigest,
        uint64 firstSeq,
        uint64 lastSeq
    );

    error NotOwner();
    error NotGateway();
    error BadRange(uint64 firstSeq, uint64 lastSeq);
    error SequenceGap(uint64 expected, uint64 got);

    constructor() {
        owner = msg.sender;
    }

    function setGateway(address gateway, bool active) external {
        if (msg.sender != owner) revert NotOwner();
        isGateway[gateway] = active;
        emit GatewaySet(gateway, active);
    }

    /// @notice Anchor one batch. Called by the gateway's own account.
    function anchorBatch(bytes32 root, bytes32 manifestDigest, uint64 firstSeq, uint64 lastSeq)
        external
        returns (uint256 batchNo)
    {
        if (!isGateway[msg.sender]) revert NotGateway();
        if (lastSeq < firstSeq) revert BadRange(firstSeq, lastSeq);
        uint64 expected = nextSeq[msg.sender];
        if (firstSeq != expected) revert SequenceGap(expected, firstSeq);

        Batch[] storage list = _batches[msg.sender];
        batchNo = list.length;
        list.push(Batch(root, manifestDigest, firstSeq, lastSeq, uint64(block.timestamp)));
        nextSeq[msg.sender] = lastSeq + 1;
        emit BatchAnchored(msg.sender, batchNo, root, manifestDigest, firstSeq, lastSeq);
    }

    function batchCount(address gateway) external view returns (uint256) {
        return _batches[gateway].length;
    }

    function getBatch(address gateway, uint256 batchNo) external view returns (Batch memory) {
        return _batches[gateway][batchNo];
    }

    /// @notice Find the anchored batch that covers `seq` (binary search; free to call).
    function findBatch(address gateway, uint64 seq)
        external
        view
        returns (bool found, uint256 batchNo, Batch memory batch)
    {
        Batch[] storage list = _batches[gateway];
        uint256 lo = 0;
        uint256 hi = list.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            Batch storage b = list[mid];
            if (seq < b.firstSeq) {
                hi = mid;
            } else if (seq > b.lastSeq) {
                lo = mid + 1;
            } else {
                return (true, mid, b);
            }
        }
        return (false, 0, batch);
    }
}
