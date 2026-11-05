import { Transformer } from "@napi-rs/image";

export async function PNG(buffer) {
  const image = new Transformer(buffer);
  const { width, height } = await image.metadata();
  const data = await image.rawPixels();
  const channels = data.length / (width * height);
  const backgroundIndex = (Math.floor(height / 2) * width + 10) * channels;
  const background = Array.from(data.subarray(backgroundIndex, backgroundIndex + 3));
  let labelPixels = 0;
  for (let y = Math.floor(height / 4); y < Math.ceil((3 * height) / 4); y++) {
    for (let x = Math.floor(width / 3); x < Math.ceil((2 * width) / 3); x++) {
      const index = (y * width + x) * channels;
      if (
        Math.max(...background.map((value, channel) => Math.abs(data[index + channel] - value))) >
        60
      )
        labelPixels++;
    }
  }
  return { labelPixels, width, height, channels, background };
}
