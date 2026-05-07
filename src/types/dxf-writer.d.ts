declare module 'dxf-writer' {
  export default class Drawing {
    constructor();
    setUnits(units: string): this;
    drawPolyline(points: [number, number][], closed?: boolean): this;
    addLayer(name: string, color: number, lineType: string): this;
    setActiveLayer(name: string): this;
    toDxfString(): string;
  }
}
