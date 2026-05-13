/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {ImageFrame} from '@/common/codecs/VideoDecoder';
import {ArrayBufferTarget, Muxer} from 'mp4-muxer';
import {MP4ArrayBuffer} from 'mp4box';

// The selection of timescale and seconds/key-frame value are
// explained in the following docs: https://github.com/vjeux/mp4-h264-re-encode
const SECONDS_PER_KEY_FRAME = 2;

export function encode(
  width: number,
  height: number,
  numFrames: number,
  duration: number,
  framesGenerator: AsyncGenerator<ImageFrame, unknown>,
  progressCallback?: (progress: number) => void,
): Promise<MP4ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let encodedFrameIndex = 0;
    let nextKeyFrameTimestamp = 0;
    let hasSettled = false;
    const safeDuration = duration > 0 ? duration : (numFrames * 1_000_000) / 30;
    const frameRate = numFrames / (safeDuration / 1_000_000);
    const frameDurations = new Map<number, number>();

    function fail(error: unknown) {
      if (!hasSettled) {
        hasSettled = true;
        reject(error);
      }
    }

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: 'avc',
        width: roundToNearestEven(width),
        height: roundToNearestEven(height),
      },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'strict',
    });

    const encoder = new VideoEncoder({
      output(chunk, metaData) {
        const duration = frameDurations.get(chunk.timestamp);
        if (duration == null) {
          fail(
            new Error(
              `Cannot find duration for encoded frame timestamp ${chunk.timestamp}`,
            ),
          );
          return;
        }
        frameDurations.delete(chunk.timestamp);

        const uint8 = new Uint8Array(chunk.byteLength);
        chunk.copyTo(uint8);
        muxer.addVideoChunkRaw(
          uint8,
          chunk.type,
          chunk.timestamp,
          duration,
          metaData,
        );
        encodedFrameIndex++;
        progressCallback?.(encodedFrameIndex / numFrames);
      },
      error(error) {
        fail(error);
      },
    });

    const setConfigurationAndEncodeFrames = async () => {
      // The codec value was taken from the following implementation and seems
      // reasonable for our use case for now:
      // https://github.com/vjeux/mp4-h264-re-encode/blob/main/mp4box.html#L103

      // Additional details about codecs can be found here:
      //  - https://developer.mozilla.org/en-US/docs/Web/Media/Formats/codecs_parameter
      //  - https://www.w3.org/TR/webcodecs-codec-registry/#video-codec-registry
      //
      // The following setting is a good compromise between output video file
      // size and quality. The latencyMode "realtime" is needed for Safari,
      // which otherwise will produce 20x larger files when in quality
      // latencyMode. Chrome does a really good job with file size even when
      // latencyMode is set to quality.
      const configuration: VideoEncoderConfig = {
        codec: 'avc1.4d0034',
        width: roundToNearestEven(width),
        height: roundToNearestEven(height),
        bitrate: 14_000_000,
        alpha: 'discard',
        avc: {format: 'avc'},
        bitrateMode: 'variable',
        framerate: frameRate,
        latencyMode: 'realtime',
      };
      const supportedConfig =
        await VideoEncoder.isConfigSupported(configuration);
      if (supportedConfig.supported === true) {
        encoder.configure(configuration);
      } else {
        throw new Error(
          `Unsupported video encoder config ${JSON.stringify(supportedConfig)}`,
        );
      }

      for await (const frame of framesGenerator) {
        const {bitmap, duration, timestamp} = frame;
        frameDurations.set(timestamp, duration);
        let keyFrame = false;
        if (timestamp >= nextKeyFrameTimestamp) {
          await encoder.flush();
          keyFrame = true;
          nextKeyFrameTimestamp = timestamp + SECONDS_PER_KEY_FRAME * 1e6;
        }
        encoder.encode(bitmap, {keyFrame});
        bitmap.close();
      }

      await encoder.flush();
      encoder.close();

      if (encodedFrameIndex !== numFrames) {
        throw new Error(
          `Encoded ${encodedFrameIndex} frames, expected ${numFrames}`,
        );
      }

      muxer.finalize();
      const buffer = target.buffer as MP4ArrayBuffer;
      buffer.fileStart = 0;
      hasSettled = true;
      resolve(buffer);
    };

    setConfigurationAndEncodeFrames().catch(fail);
  });
}

function roundToNearestEven(dim: number) {
  const rounded = Math.round(dim);

  if (rounded % 2 === 0) {
    return rounded;
  } else {
    return rounded + (rounded > dim ? -1 : 1);
  }
}
