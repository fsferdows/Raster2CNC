import Drawing from 'dxf-writer';

export type Point = { x: number; y: number };
export type CNCParams = {
  toolDiameter: number;
  feedRate: number;
  plungeRate: number;
  safeZ: number;
  cutDepth: number;
  spindleSpeed: number;
};

function getSignedArea(path: Point[]): number {
  let area = 0;
  for (let i = 0; i < path.length; i++) {
    const j = (i + 1) % path.length;
    area += path[i].x * path[j].y - path[j].x * path[i].y;
  }
  return area / 2;
}

export type LayerGroup = {
  id: string;
  name: string;
  paths: Point[][];
  color: string;
  dxfColor: number;
  visible: boolean;
};

export function categorizePaths(paths: Point[][]): LayerGroup[] {
  if (paths.length === 0) return [];

  const pathData = paths.map(p => {
    const sa = getSignedArea(p);
    return { path: p, signedArea: sa, absArea: Math.abs(sa) };
  });

  let sumPositive = 0;
  let sumNegative = 0;
  let maxArea = 0;

  pathData.forEach(p => {
    if (p.signedArea > 0) sumPositive += p.absArea;
    else sumNegative += p.absArea;
    if (p.absArea > maxArea) maxArea = p.absArea;
  });

  // The sign with the most total area reliably represents the outer boundaries
  const isPositiveOuter = sumPositive > sumNegative;
  // Let "large" be anything >= 5% of the largest contiguous path 
  const sizeThreshold = maxArea * 0.05;

  const outerLarge: Point[][] = [];
  const outerSmall: Point[][] = [];
  const holesLarge: Point[][] = [];
  const holesSmall: Point[][] = [];

  pathData.forEach(p => {
    const isOuter = (p.signedArea > 0) === isPositiveOuter;
    const isLarge = p.absArea >= sizeThreshold;

    if (isOuter) {
      if (isLarge) outerLarge.push(p.path);
      else outerSmall.push(p.path);
    } else {
      if (isLarge) holesLarge.push(p.path);
      else holesSmall.push(p.path);
    }
  });

  const layers: LayerGroup[] = [];
  // Use explicit sizes in the layer names for easier identification in AutoCAD/ArtCAM
  // Standard CAD Colors: White/Black (7), Blue (5), Red (1), Green (3)
  if (outerLarge.length > 0) layers.push({ id: 'l1', name: 'Outer_Boundaries_Large', paths: outerLarge, color: '#000000', dxfColor: 7, visible: true }); 
  if (outerSmall.length > 0) layers.push({ id: 'l2', name: 'Outer_Boundaries_Small', paths: outerSmall, color: '#0000FF', dxfColor: 5, visible: true }); 
  if (holesLarge.length > 0) layers.push({ id: 'l3', name: 'Inner_Holes_Large', paths: holesLarge, color: '#FF0000', dxfColor: 1, visible: true }); 
  if (holesSmall.length > 0) layers.push({ id: 'l4', name: 'Inner_Holes_Small', paths: holesSmall, color: '#00FF00', dxfColor: 3, visible: true }); 
  
  if (layers.length === 0 && paths.length > 0) {
      layers.push({ id: 'l5', name: 'All_Paths', paths, color: '#000000', dxfColor: 7, visible: true });
  }

  return layers;
}

export function generateSVG(layers: LayerGroup[], width: number, height: number, mode: 'color' | 'bw' = 'bw'): string {
  let svgContent = '';
  layers.forEach((layer) => {
    // For CNC B/W mode, typical is stroke only. For color layer, fill with color.
    const fillAttr = mode === 'color' ? `fill="${layer.color}"` : `fill="none"`;
    const strokeAttr = mode === 'color' ? `stroke="${layer.color}" stroke-width="0.1"` : `stroke="${layer.color}" stroke-width="0.5"`;
    
    svgContent += `  <g id="${layer.name}" ${strokeAttr} ${fillAttr}>\n`;
    
    const svgPaths = layer.paths.map(path => {
      if (path.length === 0) return '';
      const d = path.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ');
      return `    <path d="${d} Z" stroke-linecap="round" stroke-linejoin="round" />`;
    }).join('\n');

    svgContent += svgPaths + '\n  </g>\n';
  });

  return `<svg width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">\n${svgContent}</svg>`;
}

export function generateDXF(layers: LayerGroup[], height: number): string {
  try {
    const d = new Drawing();
    d.setUnits('Millimeters');
    
    layers.forEach(layer => {
      d.addLayer(layer.name, layer.dxfColor, 'CONTINUOUS');
      d.setActiveLayer(layer.name);
      
      layer.paths.forEach(path => {
        if (path.length < 2) return;
        const vertexes = path.map(p => [p.x, height - p.y] as [number, number]);
        d.drawPolyline(vertexes, true);
      });
    });
    
    return d.toDxfString();
  } catch(e) {
    console.error("DXF generation failed, falling back to manual polyline", e);
    // Fallback if dxf-writer has issues
    let dxf = "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n";
    // Layer Table
    dxf += "0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n" + layers.length + "\n";
    layers.forEach(layer => {
      dxf += "0\nLAYER\n2\n" + layer.name + "\n70\n0\n62\n" + layer.dxfColor + "\n6\nCONTINUOUS\n";
    });
    dxf += "0\nENDTAB\n0\nENDSEC\n";
    
    // Entities
    dxf += "0\nSECTION\n2\nENTITIES\n";
    layers.forEach(layer => {
      layer.paths.forEach(path => {
        if (path.length < 2) return;
        dxf += "0\nPOLYLINE\n8\n" + layer.name + "\n66\n1\n70\n1\n"; 
        path.forEach(p => {
            dxf += `0\nVERTEX\n8\n${layer.name}\n10\n${p.x.toFixed(3)}\n20\n${(height - p.y).toFixed(3)}\n30\n0.0\n`;
        });
        dxf += "0\nSEQEND\n8\n" + layer.name + "\n";
      });
    });
    dxf += "0\nENDSEC\n0\nEOF\n";
    return dxf;
  }
}

export function generateGCode(paths: Point[][], params: CNCParams, height: number): string {
  const { feedRate, plungeRate, safeZ, cutDepth, spindleSpeed } = params;
  let gcode = "%\n";
  gcode += "( Generated by Raster2CNC )\n";
  gcode += "G21 ( Metric )\n";
  gcode += "G90 ( Absolute positioning )\n";
  gcode += "G17 ( XY Plane )\n";
  gcode += "G94 ( Feed per minute )\n";
  
  // Safe home before starting
  gcode += `G00 Z${safeZ} ( Move to Safe Z )\n`;
  gcode += `S${spindleSpeed} M03 ( Start spindle )\n`;
  gcode += "G04 P2 ( Pause 2 seconds for spindle to reach speed )\n\n";

  paths.forEach((path, i) => {
    if (path.length === 0) return;
    
    // Move to start point of the path
    const start = path[0];
    gcode += `( Path ${i + 1} )\n`;
    gcode += `G00 X${start.x.toFixed(3)} Y${(height - start.y).toFixed(3)}\n`;
    
    // Plunge
    gcode += `G01 Z-${cutDepth} F${plungeRate}\n`;
    
    // Cutting moves
    path.forEach((p, idx) => {
      if (idx === 0) return; // already moved to start
      gcode += `G01 X${p.x.toFixed(3)} Y${(height - p.y).toFixed(3)} F${feedRate}\n`;
    });
    
    // Close the path
    gcode += `G01 X${start.x.toFixed(3)} Y${(height - start.y).toFixed(3)} F${feedRate}\n`;
    
    // Retract
    gcode += `G00 Z${safeZ}\n\n`;
  });

  gcode += "M05 ( Stop spindle )\n";
  gcode += `G00 Z${safeZ} ( Return to safe Z )\n`;
  gcode += "G00 X0 Y0 ( Return to machine zero )\n";
  gcode += "M30 ( End program )\n%";

  return gcode;
}
