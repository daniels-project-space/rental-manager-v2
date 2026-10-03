# Booking edits require the current renter inbound

The legacy Lab edit mutation accepted a missing request message ID and an ID belonging to the latest owner message. A controlled native test moved a confirmed 20–21 October camera booking to 20–22 October in both cases, changing its total from £124 to £170. These tests deliberately supplied conflicting tool arguments; they do not show the model choosing an unwanted edit.

`applyChange` now requires a nonempty ID equal to the actual latest message, whose sender must be the renter, before any non-preview addition, removal or date change. This matches the existing atomic addition contract. Read-only addition previews remain available without an edit request. The canonical server tool scope already binds the actual renter message ID; model arguments cannot choose it.

Fifteen new transaction cases cover missing, empty and stale IDs, owner-last conversations and missing messages for all three actions, asserting the complete fixture is unchanged. Existing transaction tests now supply inbound identities as the server caller does. This change verifies the actor and message freshness; it does not prove positive consent to the selected items, quantities, price or dates.

The broader consent audit also reproduced unrequested removal and date changes when supplied with a valid ID for a camera-weight question. This remains open and requires reconciliation of explicit renter requests and accepted proposals. `setDraft` saves draft evidence on the conversation; `recordSentReply` saves owner text but does not archive a separate structured proposal linked to that sent message. Natural replies such as “yes, add both” therefore need an authoritative proposal contract, rather than treating freshness or the absence of a prohibition as permission.

Native baseline: `/root/rental-consent-boundaries-native-proof.json`. These are disposable `__probe__` Lab sessions; all were cleaned. Real Hygglo messaging and booking writes remain disabled and require separate explicit written consent.
