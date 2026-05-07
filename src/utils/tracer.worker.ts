import { Point, LayerGroup } from './exporters';
import { processImage } from './imageProcessing';

self.onmessage = async (e: MessageEvent) => {
  const { 
    imageData, 
    thresholdValue, 
    simplificationTolerance, 
    outputWidthMm, 
    mode, 
    colorCount, 
    pathOmit, 
    curveTolerance 
  } = e.data;

  try {
    const result = processImage(
      imageData,
      thresholdValue,
      simplificationTolerance,
      outputWidthMm,
      mode,
      colorCount,
      pathOmit,
      curveTolerance
    );
    self.postMessage({ success: true, result });
  } catch (error: any) {
    self.postMessage({ success: false, error: error?.message || String(error), stack: error?.stack });
  }
};
