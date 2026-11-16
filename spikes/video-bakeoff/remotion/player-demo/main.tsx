// Embeds the same composition in a web page with @remotion/player and edits props live
// (the shape a property-panel editor would use).
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player, PlayerRef } from "@remotion/player";
import { Venta, ventaDefaults, VentaProps } from "../src/Venta";

const App: React.FC = () => {
  const [props, setProps] = useState<VentaProps>(ventaDefaults);
  const ref = useRef<PlayerRef>(null);
  (window as unknown as { player: typeof ref }).player = ref; // handle for scripted checks
  const set = (k: keyof VentaProps) => (e: React.ChangeEvent<HTMLInputElement>) => setProps({ ...props, [k]: e.target.value });
  return (
    <div style={{ display: "flex", gap: 24, padding: 16, fontFamily: "system-ui" }}>
      <Player
        ref={ref}
        component={Venta}
        inputProps={props}
        durationInFrames={240}
        fps={30}
        compositionWidth={1080}
        compositionHeight={1920}
        style={{ height: "85vh", aspectRatio: "9 / 16" }}
        controls
        loop
      />
      <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
        <label>Headline <input id="headline" value={props.headline} onChange={set("headline")} /></label>
        <label>Product name <input id="productName" value={props.productName} onChange={set("productName")} /></label>
        <label>Brand green <input id="colorPrimary" type="color" value={props.colorPrimary} onChange={set("colorPrimary")} /></label>
      </div>
    </div>
  );
};

createRoot(document.getElementById("root")!).render(<App />);
