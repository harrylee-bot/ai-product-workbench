export type ImageCrop = { x: number; y: number; width: number; height: number };

export async function cropStudioImage(
  file: File,
  area: ImageCrop,
): Promise<File> {
  if (
    ![area.x, area.y, area.width, area.height].every(Number.isFinite) ||
    area.x < 0 ||
    area.y < 0 ||
    area.width <= 0 ||
    area.height <= 0
  )
    throw new Error("裁剪范围无效，请重新选择");
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const x = Math.round(area.x),
      y = Math.round(area.y);
    const width = Math.round(area.width),
      height = Math.round(area.height);
    if (
      width < 1 ||
      height < 1 ||
      x + width > bitmap.width ||
      y + height > bitmap.height ||
      width > 16_384 ||
      height > 16_384 ||
      width * height > 32_000_000
    )
      throw new Error("裁剪区域超出图片范围或尺寸限制，请缩小范围");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理图片裁剪");
    context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("图片裁剪失败"))),
        "image/png",
      ),
    );
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}-crop.png`, {
      type: "image/png",
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}
