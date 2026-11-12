import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, LAYOUT_NODE, type StackLayoutNode } from "@earendil-works/pi-tui";
import type { SessionEntry } from "../../core/session-manager.ts";

/** Structural transcript containers expose the same children they actually render to root layout. */
export class TranscriptContainer extends Container {
	[LAYOUT_NODE](): StackLayoutNode {
		return {
			type: "vstack",
			entries: this.children.map((component) => ({ component })),
			gap: 0,
			align: "stretch",
		};
	}
}

/** Stable render-lifetime identity, later associated with a persisted canonical entry. */
export interface TranscriptEntryIdentity {
	entryId?: string;
}

/** Session-scoped identities: neither equal text nor equal timestamps identify an entry. */
export class TranscriptEntryIdentities {
	private readonly messages = new WeakMap<AgentMessage, TranscriptEntryIdentity>();
	private readonly persisted = new Map<string, TranscriptEntryIdentity>();

	get(message: AgentMessage, entryId?: string): TranscriptEntryIdentity {
		const identity = this.messages.get(message) ?? (entryId ? this.persisted.get(entryId) : undefined) ?? {};
		this.messages.set(message, identity);
		if (entryId) {
			identity.entryId = entryId;
			this.persisted.set(entryId, identity);
		}
		return identity;
	}

	/** Persistence follows public message delivery. Associate by the stored object, never by position. */
	associate(entries: readonly SessionEntry[]): void {
		for (const entry of entries) {
			if (entry.type === "message" && this.messages.has(entry.message)) this.get(entry.message, entry.id);
		}
	}
}
