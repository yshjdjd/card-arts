/** Browser workers cannot reliably decode SVG blobs; rasterize once before dispatching jobs. */
export async function rasterizeSvg(url: string): Promise<{ url: string; dispose: () => void }> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img); img.onerror = () => reject(new Error(`无法读取 SVG 素材：${url}`)); img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, image.naturalWidth || image.width);
  canvas.height = Math.max(1, image.naturalHeight || image.height);
  const context = canvas.getContext('2d'); if (!context) throw new Error('无法栅格化 SVG');
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('SVG 转换失败')), 'image/png'));
  const rasterUrl = URL.createObjectURL(blob);
  return { url: rasterUrl, dispose: () => URL.revokeObjectURL(rasterUrl) };
}
