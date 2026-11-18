import type { ApiClient, Job } from "@studio/contract";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageGeneratorSheet } from "../../src/renderer/features/media/image-generator.tsx";
import { ApiContext } from "../../src/renderer/lib/api.ts";

// U7: every submit starts a paid `image.generate` job; ⌘↩ pressed twice must start one.

function setup() {
  let finish: (job: Job) => void = () => undefined;
  const create = vi.fn(
    () =>
      new Promise<Job>((resolve) => {
        finish = resolve;
      }),
  );
  const onClose = vi.fn();
  render(
    <ApiContext.Provider value={{ jobs: { create } } as unknown as ApiClient}>
      <ImageGeneratorSheet open onClose={onClose} brandId="b1" assets={[]} />
    </ApiContext.Provider>,
  );
  const prompt = screen.getByPlaceholderText(/hasat sonrası/);
  fireEvent.change(prompt, { target: { value: "tarlada sabah ışığı" } });
  return { create, onClose, prompt, finish: (job: Job) => finish(job) };
}

describe("AI image generator", () => {
  it("starts one job when ⌘↩ is pressed twice before the first answer", async () => {
    const { create, onClose, prompt, finish } = setup();
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Gönderiliyor…" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image.generate", brandId: "b1" }),
    );
    await act(async () => finish({ id: "j1" } as Job));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("can send again once the first job was accepted", async () => {
    const { create, prompt, finish } = setup();
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    await act(async () => finish({ id: "j1" } as Job));
    fireEvent.change(prompt, { target: { value: "ikinci tarif" } });
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not send an empty description with ⌘↩", () => {
    const { create, prompt } = setup();
    fireEvent.change(prompt, { target: { value: "   " } });
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    expect(create).not.toHaveBeenCalled();
  });
});
