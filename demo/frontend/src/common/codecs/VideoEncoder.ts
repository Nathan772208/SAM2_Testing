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
import {MP4ArrayBuffer, createFile} from 'mp4box';

// The selection of timescale and seconds/key-frame value are
// explained in the following docs: https://github.com/vjeux/mp4-h264-re-encode
const TIMESCALE = 90000;
const SECONDS_PER_KEY_FRAME = 2;

type SampleTiming = {
  dts: number;
  duration: number;
};

type MP4FileWithMovie = ReturnType<typeof createFile> & {
  moov?: {
    mvex?: {
      mehd?: unknown;
      add: (name: string) => {
        set: (property: string, value: number) => unknown;
      };
    };
    mvhd?: {
      duration: number;
    };
  };
};

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
    let trackID: number | null = null;
    const safeDuration = duration > 0 ? duration : (numFrames * 1_000_000) / 30;
    const defaultFrameDuration = safeDuration / Math.max(1, numFrames);
    const defaultSampleDuration = getScaledDuration(defaultFrameDuration);
    const sampleTimings: SampleTiming[] = [];

    const outputFile = createFile();

    const encoder = new VideoEncoder({
      output(chunk, metaData) {
        const uint8 = new Uint8Array(chunk.byteLength);
        chunk.copyTo(uint8);

        const description = metaData?.decoderConfig?.description;
        if (trackID === null) {
          trackID = outputFile.addTrack({
            width: width,
            height: height,
            duration: getScaledDuration(safeDuration),
            media_duration: getScaledDuration(safeDuration),
            timescale: TIMESCALE,
            default_sample_duration: defaultSampleDuration,
            avcDecoderConfigRecord: description,
          });
          setFragmentDuration(outputFile, getScaledDuration(safeDuration));
        }
        const timing = sampleTimings[encodedFrameIndex];
        if (timing == null) {
          reject(
            new Error(
              `Cannot find sample timing for encoded frame ${encodedFrameIndex}`,
            ),
          );
          return;
        }
        outputFile.addSample(trackID, uint8, {
          cts: timing.dts,
          dts: timing.dts,
          duration: timing.duration,
          is_sync: chunk.type === 'key',
        });
        encodedFrameIndex++;
        progressCallback?.(encodedFrameIndex / numFrames);

        if (encodedFrameIndex === numFrames) {
          resolve(outputFile.getBuffer());
        }
      },
      error(error) {
        reject(error);
        return;
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
        bitrateMode: 'variable',
        framerate: numFrames / (safeDuration / 1_000_000),
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
        sampleTimings.push({
          // mp4box 0.5.2 treats a first DTS of 0 as unset because it checks
          // the value as a boolean. Offset all DTS values by one sample; the
          // writer subtracts the first DTS again when producing tfdt.
          dts: getScaledTimestamp(timestamp) + defaultSampleDuration,
          duration: getScaledDuration(duration),
        });
        let keyFrame = false;
        if (timestamp >= nextKeyFrameTimestamp) {
          keyFrame = true;
          nextKeyFrameTimestamp = timestamp + SECONDS_PER_KEY_FRAME * 1e6;
        }
        encoder.encode(bitmap, {keyFrame});
        bitmap.close();
      }

      await encoder.flush();
      encoder.close();
    };

    setConfigurationAndEncodeFrames().catch(reject);
  });
}

function getScaledDuration(rawDuration: number) {
  return Math.max(1, Math.round(rawDuration / (1_000_000 / TIMESCALE)));
}

function getScaledTimestamp(rawTimestamp: number) {
  return Math.round(rawTimestamp / (1_000_000 / TIMESCALE));
}

function setFragmentDuration(file: MP4FileWithMovie, duration: number) {
  const outputFile = file as MP4FileWithMovie;
  if (outputFile.moov?.mvhd != null) {
    outputFile.moov.mvhd.duration = duration;
  }
  if (outputFile.moov?.mvex != null && outputFile.moov.mvex.mehd == null) {
    outputFile.moov.mvex.add('mehd').set('fragment_duration', duration);
  }
}

function roundToNearestEven(dim: number) {
  const rounded = Math.round(dim);

  if (rounded % 2 === 0) {
    return rounded;
  } else {
    return rounded + (rounded > dim ? -1 : 1);
  }
}
