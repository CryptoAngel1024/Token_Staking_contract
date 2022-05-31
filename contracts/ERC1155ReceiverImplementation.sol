//SPDX-License-Identifier: Unlicense
pragma solidity >=0.6.0 <=0.8.0;

import "@openzeppelin/contract-0.6.0/token/ERC1155/IERC1155Receiver.sol";

abstract contract ERC1155ReceiverImplementation is IERC1155Receiver {
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external override returns (bytes4) {
        return
            bytes4(
                keccak256(
                    "onERC1155Received(address,address,uint256,uint256,bytes)"
                )
            );
    }

    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external override returns (bytes4) {
        return
            bytes4(
                keccak256(
                    "onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)"
                )
            );
    }

    function supportsInterface(bytes4 interfaceId)
        external
        view
        override
        returns (bool)
    {
        return type(IERC1155Receiver).interfaceId == interfaceId;
    }
}
