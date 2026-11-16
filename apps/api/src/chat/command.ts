import type { ChatOutcome } from "../hub.ts";
import { ApiProblem } from "../lib/errors.ts";
import { hubStub } from "../routes/jobs.ts";
import type { ChatCommand, ChatResults } from "./service.ts";

/**
 * Run a chat command in the Hub's serial queue and return its typed result.
 * Problems come back as data (RPC does not keep error classes) and are
 * rethrown here as ApiProblem, so routes answer with the usual error shape.
 */
export async function runChat<C extends ChatCommand>(
  env: Env,
  command: C,
): Promise<ChatResults[C["kind"]]> {
  const outcome = (await hubStub(env).chat(command)) as ChatOutcome;
  if (!outcome.ok) {
    throw new ApiProblem(outcome.problem.code, outcome.problem.message, outcome.problem.issues);
  }
  return outcome.value as ChatResults[C["kind"]];
}
