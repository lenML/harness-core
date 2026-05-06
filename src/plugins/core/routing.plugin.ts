import fs from "node:fs";
import path from "node:path";
import type {
  CoreContext,
  AgentPlugin,
  IRouter,
  InboundMessage,
} from "../../types";

class Binding {
  agentId: string;
  tier: number;
  matchKey: string;
  matchValue: string;
  priority: number;
  constructor(
    agentId: string,
    tier: number,
    matchKey: string,
    matchValue: string,
    priority = 0
  ) {
    this.agentId = agentId;
    this.tier = tier;
    this.matchKey = matchKey;
    this.matchValue = matchValue;
    this.priority = priority;
  }
}

class BindingTable {
  private bindings: Binding[] = [];
  add(b: Binding) {
    this.bindings.push(b);
    this.bindings.sort((a, b) =>
      a.tier !== b.tier ? a.tier - b.tier : b.priority - a.priority
    );
  }
  listAll() {
    return [...this.bindings];
  }
  resolve(
    channel = "",
    accountId = "",
    guildId = "",
    peerId = ""
  ): [string | null, Binding | null] {
    for (const b of this.bindings) {
      if (b.tier === 1 && b.matchKey === "peer_id") {
        if (b.matchValue === peerId) return [b.agentId, b];
      } else if (
        b.tier === 2 &&
        b.matchKey === "guild_id" &&
        b.matchValue === guildId
      )
        return [b.agentId, b];
      else if (
        b.tier === 3 &&
        b.matchKey === "account_id" &&
        b.matchValue === accountId
      )
        return [b.agentId, b];
      else if (
        b.tier === 4 &&
        b.matchKey === "channel" &&
        b.matchValue === channel
      )
        return [b.agentId, b];
      else if (b.tier === 5 && b.matchKey === "default") return [b.agentId, b];
    }
    return [null, null];
  }
}

/**
 * Parse a peerId that uses the "agent:<agentId>:<actualPeer>" convention.
 *
 * Returns [agentId, actualPeerId]. If the peerId doesn't follow the convention,
 * returns [null, originalPeerId].
 *
 * Handles edge cases:
 *  - "agent:main:ws-client" → ["main", "ws-client"]
 *  - "agent:main"           → ["main", "main"]  (no peer part after agentId)
 *  - "agent:main:a:b:c"    → ["main", "a:b:c"]  (peerId contains colons)
 *  - "ws-client"            → [null, "ws-client"]
 */
function parseAgentPeerId(peerId: string): [string | null, string] {
  const prefix = "agent:";
  if (!peerId.startsWith(prefix)) return [null, peerId];

  const withoutPrefix = peerId.slice(prefix.length);
  const firstColon = withoutPrefix.indexOf(":");

  if (firstColon >= 0) {
    const agentId = withoutPrefix.slice(0, firstColon);
    const actualPeerId = withoutPrefix.slice(firstColon + 1);
    return [agentId, actualPeerId];
  }

  // No colon after agentId — agentId is the entire remaining string
  return [withoutPrefix, withoutPrefix];
}

/**
 * Build a stable session key from components.
 * Format: "agent:<agentId>:<channel>:<peerId>"
 *
 * The peerId is always the *actual* peer identifier, never prefixed with "agent:".
 * This prevents recursive nesting like "agent:main:ws:agent:main:ws-client".
 */
function buildSessionKey(
  agentId: string,
  channel: string,
  peerId: string
): string {
  return `agent:${agentId}:${channel}:${peerId}`;
}

export class RoutingPlugin implements AgentPlugin {
  name = "routing";
  async install(ctx: CoreContext) {
    const bt = new BindingTable();
    // Default catch-all binding → main agent
    bt.add(new Binding("main", 5, "default", "*"));

    ctx.provide("bindings", bt);

    // Load bindings from .harness/routing.json if exists
    const routingPath = path.join(ctx.getProjectWorkspace(), "routing.json");
    if (fs.existsSync(routingPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(routingPath, "utf-8"));
        for (const b of raw.bindings || []) {
          if (b.agentId && b.tier && b.matchKey && b.matchValue) {
            bt.add(
              new Binding(
                b.agentId,
                b.tier,
                b.matchKey,
                b.matchValue,
                b.priority || 0
              )
            );
          }
        }
        console.log(
          `[Routing] Loaded ${
            raw.bindings?.length || 0
          } bindings from .harness/routing.json`
        );
      } catch (err: any) {
        console.error(`[Routing] Failed to load routing.json: ${err.message}`);
      }
    }

    ctx.registerRouter({
      resolve(msg: InboundMessage) {
        // Check if peerId uses the "agent:<agentId>:<peer>" convention
        const [explicitAgentId, actualPeerId] = parseAgentPeerId(msg.peerId);

        if (explicitAgentId) {
          return {
            agentId: explicitAgentId,
            sessionKey: buildSessionKey(
              explicitAgentId,
              msg.channel,
              actualPeerId
            ),
          };
        }

        // Fall back to binding table resolution
        const [agentId] = bt.resolve(
          msg.channel,
          msg.accountId,
          "",
          msg.peerId
        );
        const resolvedAgentId = agentId || "main";
        return {
          agentId: resolvedAgentId,
          sessionKey: buildSessionKey(resolvedAgentId, msg.channel, msg.peerId),
        };
      },
    });
  }
}
