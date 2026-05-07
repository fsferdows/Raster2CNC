import ImageTracerRaw from 'imagetracerjs';
import simplify from 'simplify-js';
import { Point, LayerGroup } from './exporters';

// Sometimes CJS imports via Vite arrive as { default: {...} } or they register to window.
const ImageTracer: any = (ImageTracerRaw as any)?.default || ImageTracerRaw || (window as any).ImageTracer;

export function processImage(
  imageData: ImageData, 
  thresholdValue: number, 
  simplificationTolerance: number,
  outputWidthMm: number,
  mode: 'color' | 'bw' = 'bw',
  colorCount: number = 16,
  pathOmit: number = 0,
  curveTolerance: number = 1
): { layers: LayerGroup[], widthPx: number, heightPx: number, mmHeight: number, svgString?: string } {
  
  const width = imageData.width;
  const height = imageData.height;

  // Clone imageData so we don't mutate the original
  const newImgData = new ImageData(
    new Uint8ClampedArray(imageData.data),
    width,
    height
  );

  const data = newImgData.data;

  if (mode === 'bw') {
    // We threshold the image in place based on luminance, but this time we will 
    // allow the user to control the threshold perfectly, creating a pure B/W image.
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i+3];
        if (a < 128) {
            data[i] = 255; data[i+1] = 255; data[i+2] = 255; data[i+3] = 255;
        } else {
            const luminance = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
            if (luminance < thresholdValue) {
               data[i] = 0; data[i+1] = 0; data[i+2] = 0; data[i+3] = 255;
            } else {
               data[i] = 255; data[i+1] = 255; data[i+2] = 255; data[i+3] = 255;
            }
        }
    }
  }

  // We use ImageTracer with specific options to get smooth curves
  const options = mode === 'bw' ? {
    colorsampling: 0, 
    numberofcolors: 2, 
    pathomit: pathOmit,
    layering: 0,
    linefilter: true,
    scale: 1,
    qtres: curveTolerance, 
    ltres: curveTolerance,  
    roundcoords: 3,
    pal: [{r:255,g:255,b:255,a:255}, {r:0,g:0,b:0,a:255}] 
  } : {
    // Colorful trace!
    corsenabled: false,
    ltres: curveTolerance,
    qtres: curveTolerance,
    pathomit: pathOmit,
    rightangleenhance: true,
    colorsampling: 2, // Sample colors
    numberofcolors: colorCount > 256 ? 256 : colorCount, // Imagetracer crashes > 256
    mincolorratio: 0,
    colorquantcycles: 3,
    blurradius: 0, // No blur for 100% strict tracing
    blurdelta: 0,  // No blur for 100% strict tracing
    layering: 0,
    strokewidth: 1,
    linefilter: false,
    scale: 1,
    roundcoords: 3, // higher precision
  };
  
  // Extract parsed paths for CNC
  const tracedata = ImageTracer.imagedataToTracedata(newImgData, options);

  // Extract a perfect SVG string using ImageTracer
  const svgString = ImageTracer.getsvgstring(tracedata, { ...options, scale: outputWidthMm / width, viewbox: true });
  
  const scale = outputWidthMm / width;
  const mmHeight = height * scale;

  function sampleQuadratic(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, steps: number = 8) {
     const pts = [];
     for (let i = 1; i <= steps; i++) {
         const t = i / steps;
         const u = 1 - t;
         const x = u * u * x1 + 2 * u * t * x2 + t * t * x3;
         const y = u * u * y1 + 2 * u * t * y2 + t * t * y3;
         pts.push({ x, y });
     }
     return pts;
  }

  const layerGroups: LayerGroup[] = [];

  tracedata.layers.forEach((layer: any, layerIdx: number) => {
    const color = tracedata.palette[layerIdx];
    // Skip entirely transparent layers
    if (color.a < 128) {
       return;
    }
    
    const luminance = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
    // Skip white/light colored layers only in BW mode
    if (mode === 'bw' && luminance > 128) {
       return;
    }
    
    const layerPaths: Point[][] = [];

    layer.forEach((path: any) => {
       const ringPoints: Point[] = [];
       
       path.segments.forEach((seg: any) => {
           if (ringPoints.length === 0) {
               ringPoints.push({ x: seg.x1, y: seg.y1 });
           }
           if (seg.type === 'L') {
               ringPoints.push({ x: seg.x2, y: seg.y2 });
           } else if (seg.type === 'Q') {
               const qPts = sampleQuadratic(seg.x1, seg.y1, seg.x2, seg.y2, seg.x3, seg.y3, 8);
               ringPoints.push(...qPts);
           }
       });

       if (ringPoints.length > 2) {
           const simplified = simplificationTolerance > 0 
              ? simplify(ringPoints, simplificationTolerance, true)
              : ringPoints;
           
           if (simplified.length > 2) {
               const scaled = simplified.map(p => ({
                   x: Number((p.x * scale).toFixed(3)),
                   y: Number((p.y * scale).toFixed(3))
               }));     
               layerPaths.push(scaled);
           }
       }
    });

    if (layerPaths.length > 0) {
      const hexColor = `#${color.r.toString(16).padStart(2, '0')}${color.g.toString(16).padStart(2, '0')}${color.b.toString(16).padStart(2, '0')}`;
      layerGroups.push({
        id: `layer-${layerIdx}`,
        name: `Layer_${layerIdx + 1}_${mode === 'bw' ? 'Black' : hexColor}`,
        paths: layerPaths,
        color: hexColor,
        dxfColor: mode === 'bw' ? 7 : (layerIdx % 255) + 1, // Standard AutoCAD colors
        visible: true
      });
    }
  });

  return { layers: layerGroups, widthPx: width, heightPx: height, mmHeight, svgString };
}
