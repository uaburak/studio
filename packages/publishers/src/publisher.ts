/**
 * Entry point: one object that publishes any supported request, dispatching
 * to the Instagram or Facebook state machine by `kind`.
 */

import { FacebookPublisher, type FacebookState } from "./facebook/publisher.ts";
import { GraphClient, type GraphClientOptions } from "./graph/client.ts";
import { InstagramPublisher, type InstagramState } from "./instagram/publisher.ts";
import {
  DEFAULT_MACHINE_OPTIONS,
  type MachineOptions,
  type Publisher,
  type PublisherDeps,
  type StepContext,
  type StepOutcome,
} from "./machine.ts";
import {
  type FacebookRequest,
  type InstagramRequest,
  type PublishRequest,
  platformOf,
} from "./models.ts";
import { validateRequest } from "./validation/index.ts";

export type PublishState = InstagramState | FacebookState;

export interface CreatePublisherOptions extends GraphClientOptions {
  /** Reuse an existing client instead of building one from the options. */
  graph?: GraphClient;
  machine?: Partial<MachineOptions>;
}

export interface Publishers extends Publisher<PublishRequest, PublishState> {
  readonly instagram: InstagramPublisher;
  readonly facebook: FacebookPublisher;
  readonly graph: GraphClient;
}

export function createPublisher(options: CreatePublisherOptions = {}): Publishers {
  const graph = options.graph ?? new GraphClient(options);
  const deps: PublisherDeps = {
    graph,
    clock: graph.clock,
    options: { ...DEFAULT_MACHINE_OPTIONS, ...options.machine },
  };
  const instagram = new InstagramPublisher(deps);
  const facebook = new FacebookPublisher(deps);
  return {
    platform: "any",
    instagram,
    facebook,
    graph,
    validate: (request: unknown) => validateRequest(request),
    start(request: PublishRequest): PublishState {
      return platformOf(request.kind) === "instagram"
        ? instagram.start(request as InstagramRequest)
        : facebook.start(request as FacebookRequest);
    },
    step(state: PublishState, ctx: StepContext): Promise<StepOutcome<PublishState>> {
      if (typeof state?.kind === "string" && platformOf(state.kind) === "instagram") {
        return instagram.step(state as InstagramState, ctx);
      }
      return facebook.step(state as FacebookState, ctx);
    },
  };
}
