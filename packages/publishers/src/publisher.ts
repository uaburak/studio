/**
 * Entry point: one object that publishes any supported request, dispatching
 * to the Instagram, Facebook or LinkedIn state machine by `kind`.
 */

import { FacebookPublisher, type FacebookState } from "./facebook/publisher.ts";
import { GraphClient, type GraphClientOptions } from "./graph/client.ts";
import { InstagramPublisher, type InstagramState } from "./instagram/publisher.ts";
import { LinkedInPublisher, type LinkedInState } from "./linkedin/publisher.ts";
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
  type LinkedInRequest,
  type PublishRequest,
  platformOf,
} from "./models.ts";
import { validateRequest } from "./validation/index.ts";

export type PublishState = InstagramState | FacebookState | LinkedInState;

export interface CreatePublisherOptions extends GraphClientOptions {
  /** Reuse an existing client instead of building one from the options. */
  graph?: GraphClient;
  machine?: Partial<MachineOptions>;
  linkedinBaseUrl?: string;
  linkedinVersion?: string;
}

export interface Publishers extends Publisher<PublishRequest, PublishState> {
  readonly instagram: InstagramPublisher;
  readonly facebook: FacebookPublisher;
  readonly linkedin: LinkedInPublisher;
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
  const linkedin = new LinkedInPublisher(deps, {
    baseUrl: options.linkedinBaseUrl,
    version: options.linkedinVersion,
    fetch: options.fetch,
    logger: options.logger,
  });
  return {
    platform: "any",
    instagram,
    facebook,
    linkedin,
    graph,
    validate: (request: unknown) => validateRequest(request),
    start(request: PublishRequest): PublishState {
      const platform = platformOf(request.kind);
      if (platform === "instagram") return instagram.start(request as InstagramRequest);
      if (platform === "facebook") return facebook.start(request as FacebookRequest);
      return linkedin.start(request as LinkedInRequest);
    },
    step(state: PublishState, ctx: StepContext): Promise<StepOutcome<PublishState>> {
      const platform = typeof state?.kind === "string" ? platformOf(state.kind) : "facebook";
      if (platform === "instagram") return instagram.step(state as InstagramState, ctx);
      if (platform === "facebook") return facebook.step(state as FacebookState, ctx);
      return linkedin.step(state as LinkedInState, ctx);
    },
  };
}
