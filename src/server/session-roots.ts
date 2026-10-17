/** Independent user-facing session creation inside a caller-owned authority and receipt transaction. */
import {
    AgentDoc,
    type AgentState,
    type ConversationId,
    type Tx,
} from "@earendil-works/pi-durable";
import { type SessionMeta, SessionsDoc } from "./docs.ts";

/**
 * Create an ownerless conversation, its stored agent settings and its catalogue entry together. Callers choose every
 * inherited setting and metadata field, enforce admission and persist receipts in the same transaction. AgentState
 * already stores tool/extension names; configure's AgentChange would expect registration objects instead.
 */
export async function createSessionRoot(
    tx: Tx,
    { agent, meta }: { agent: Partial<AgentState>; meta: SessionMeta },
): Promise<ConversationId> {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });

    // Tx documents can contain tracked proxies, which structuredClone cannot copy. AgentState is
    // stored JSON; materialize that data before assigning it to another tracked document.
    Object.assign(await tx.doc(AgentDoc, conversation.id), JSON.parse(JSON.stringify(agent)));
    (await tx.doc(SessionsDoc)).items[String(conversation.id)] = meta;

    return conversation.id;
}
