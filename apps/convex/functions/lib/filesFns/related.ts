/**
 * Notes related to one note, for the console's note view (Task 18).
 *
 * Handler body of `relatedNotes`, which `functions/files.ts` registers.
 * Shaped like `notePathsHandler`: read-only, and it schedules nothing.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";

/**
 * Any member, at their own clearance. A note outside it, and a note that does
 * not exist, both answer with the read operation's not-found.
 */
export async function relatedNotesHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
  },
): Promise<Extract<OperationResult, { kind: "related" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "related", path: args.path },
  });
  return result as Extract<OperationResult, { kind: "related" }>;
}
