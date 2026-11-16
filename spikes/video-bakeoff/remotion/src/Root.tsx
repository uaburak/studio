import React from "react";
import { Composition } from "remotion";
import { Venta, ventaDefaults, ventaSchema } from "./Venta";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Venta"
    component={Venta}
    schema={ventaSchema}
    defaultProps={ventaDefaults}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={240}
  />
);
