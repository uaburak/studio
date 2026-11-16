// Venta Borinc — 8 s Reel (1080x1920, 30 fps). Bake-off composition, Remotion variant.
// Brand tokens and copy arrive ONCE as props (validated by `ventaSchema`), as a brand profile would supply them.
import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/fonts";
import { z } from "zod";
import { zColor } from "@remotion/zod-types";

// Self-hosted font: served from public/, no network fetch at render time.
loadFont({ family: "Montserrat", url: staticFile("fonts/Montserrat_800ExtraBold.ttf"), weight: "800" });
loadFont({ family: "Montserrat", url: staticFile("fonts/Montserrat_600SemiBold.ttf"), weight: "600" });

export const ventaSchema = z.object({
  colorPrimary: zColor(),
  colorDeep: zColor(),
  colorSurface: zColor(),
  colorOnDark: zColor(),
  colorAccent: zColor(),
  fontDisplay: z.string(),
  headline: z.string(),
  productName: z.string(),
  productLine: z.string(),
  productImage: z.string(),
  companyName: z.string(),
  website: z.string(),
});
export type VentaProps = z.infer<typeof ventaSchema>;

export const ventaDefaults: VentaProps = {
  colorPrimary: "#3E9B3A",
  colorDeep: "#0E3B1F",
  colorSurface: "#F3F7F0",
  colorOnDark: "#FFFFFF",
  colorAccent: "#A6E38F",
  fontDisplay: "Montserrat",
  headline: "Toprağın ihtiyacı, doğru dozda.",
  productName: "VENTA BORINC",
  productLine: "Bor (B) ve Çinko (Zn)",
  productImage: "venta-borinc.png",
  companyName: "MTM AGRO",
  website: "mtmagro.com",
};

// Timing tokens (seconds). Edit here to retime the film.
const T = { wordStart: 0.3, wordStagger: 0.2, wordDur: 0.6, t1: 2.6, t2: 5.2, transition: 0.5, reveal: 0.8, text: 0.6 };
const FPS = 30;
const f = (s: number) => Math.round(s * FPS);

// GSAP "power3" is a quartic curve (power1 = quad, power2 = cubic), so poly(4) matches the HyperFrames variant.
const out3 = Easing.out(Easing.poly(4)); // == GSAP power3.out
const inOut3 = Easing.inOut(Easing.poly(4)); // == GSAP power3.inOut

/** Progress 0..1 of a tween that starts at `start` seconds and lasts `dur` seconds (scene-local time). */
const useTween = (start: number, dur: number, easing = out3) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return interpolate(frame / fps, [start, start + dur], [0, 1], {
    easing,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};
const lerp = (p: number, a: number, b: number) => a + (b - a) * p;

const Word: React.FC<{ text: string; index: number; color: string }> = ({ text, index, color }) => {
  const p = useTween(T.wordStart + index * T.wordStagger, T.wordDur);
  return (
    <span style={{ display: "inline-block", marginRight: "0.24em", color, opacity: p, transform: `translateY(${lerp(p, 90, 0)}px)` }}>
      {text}
    </span>
  );
};

const Hook: React.FC<VentaProps> = (props) => {
  const words = props.headline.trim().split(/\s+/);
  const exit = useTween(T.t1, T.transition, inOut3);
  return (
    <AbsoluteFill style={{ background: props.colorDeep, justifyContent: "center", padding: "0 96px", transform: `translateY(${lerp(exit, 0, -20)}%)` }}>
      <h1 style={{ margin: 0, color: props.colorOnDark, fontWeight: 800, fontSize: 132, lineHeight: 1.08, letterSpacing: "-0.02em" }}>
        {words.map((w, i) => (
          <Word key={i} text={w} index={i} color={i >= words.length - 2 ? props.colorAccent : props.colorOnDark} />
        ))}
      </h1>
    </AbsoluteFill>
  );
};

const Product: React.FC<VentaProps> = (props) => {
  // Scene-local times (this Sequence starts at T.t1).
  const enter = useTween(0, T.transition, inOut3);
  const s2 = T.transition - 0.1;
  const card = useTween(s2, T.reveal);
  const name = useTween(s2 + 0.5, T.text);
  const line = useTween(s2 + 0.75, T.text);
  const text: React.CSSProperties = { position: "absolute", left: 90, right: 90, margin: 0, textAlign: "center" };
  return (
    <AbsoluteFill style={{ background: props.colorSurface, transform: `translateY(${lerp(enter, 100, 0)}%)` }}>
      <div
        style={{
          position: "absolute", left: 210, top: 290, width: 660, height: 660,
          background: "#fff", borderRadius: 48, overflow: "hidden",
          boxShadow: "0 48px 96px rgba(14, 59, 31, 0.18), 0 8px 24px rgba(14, 59, 31, 0.08)",
          opacity: card, transform: `translateY(${lerp(card, 160, 0)}px) scale(${lerp(card, 0.86, 1)})`,
        }}
      >
        {/* scale(1.4) crops the white margin of the source photo */}
        <Img src={staticFile(props.productImage)} style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scale(1.4)" }} />
      </div>
      <h2 style={{ ...text, top: 1000, color: props.colorDeep, fontWeight: 800, fontSize: 104, letterSpacing: "0.02em", opacity: name, transform: `translateY(${lerp(name, 50, 0)}px)` }}>
        {props.productName}
      </h2>
      <p style={{ ...text, top: 1140, color: props.colorPrimary, fontWeight: 600, fontSize: 58, opacity: line, transform: `translateY(${lerp(line, 50, 0)}px)` }}>
        {props.productLine}
      </p>
    </AbsoluteFill>
  );
};

const Closing: React.FC<VentaProps> = (props) => {
  // Scene-local times (this Sequence starts at T.t2).
  const wipe = useTween(0, T.transition, inOut3);
  const s3 = T.transition - 0.1;
  const company = useTween(s3, T.text);
  const site = useTween(s3 + 0.25, T.text);
  return (
    <AbsoluteFill
      style={{
        background: props.colorPrimary, clipPath: `inset(${lerp(wipe, 100, 0)}% 0% 0% 0%)`,
        flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 36,
      }}
    >
      <h2 style={{ margin: 0, color: props.colorOnDark, fontWeight: 800, fontSize: 128, letterSpacing: "0.04em", opacity: company, transform: `translateY(${lerp(company, 60, 0)}px)` }}>
        {props.companyName}
      </h2>
      <p style={{ margin: 0, color: props.colorOnDark, fontWeight: 600, fontSize: 64, opacity: lerp(site, 0, 0.92), transform: `translateY(${lerp(site, 40, 0)}px)` }}>
        {props.website}
      </p>
    </AbsoluteFill>
  );
};

export const Venta: React.FC<VentaProps> = (props) => (
  <AbsoluteFill style={{ background: props.colorDeep, fontFamily: `${props.fontDisplay}, sans-serif` }}>
    <Sequence name="Hook" from={0} durationInFrames={f(T.t1 + T.transition)}>
      <Hook {...props} />
    </Sequence>
    <Sequence name="Product" from={f(T.t1)} durationInFrames={f(T.t2 + T.transition - T.t1)}>
      <Product {...props} />
    </Sequence>
    <Sequence name="Closing" from={f(T.t2)}>
      <Closing {...props} />
    </Sequence>
  </AbsoluteFill>
);
