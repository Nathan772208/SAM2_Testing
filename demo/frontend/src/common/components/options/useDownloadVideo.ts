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
import {getFileName} from '@/common/components/options/ShareUtils';
import {
  EncodingCompletedEvent,
  EncodingStateUpdateEvent,
} from '@/common/components/video/VideoWorkerBridge';
import useVideo from '@/common/components/video/editor/useVideo';
import useReportError from '@/common/error/useReportError';
import {VIDEO_API_ENDPOINT} from '@/demo/DemoConfig';
import {MP4ArrayBuffer} from 'mp4box';
import {useState} from 'react';

type DownloadingState = 'default' | 'started' | 'encoding' | 'completed';

type State = {
  state: DownloadingState;
  progress: number;
  download: (shouldSave?: boolean) => Promise<MP4ArrayBuffer>;
};

export default function useDownloadVideo(): State {
  const [downloadingState, setDownloadingState] =
    useState<DownloadingState>('default');
  const [progress, setProgress] = useState<number>(0);

  const video = useVideo();
  const reportError = useReportError();

  async function download(shouldSave = true): Promise<MP4ArrayBuffer> {
    return new Promise((resolve, reject) => {
      function onEncodingStateUpdate(event: EncodingStateUpdateEvent) {
        setDownloadingState('encoding');
        setProgress(event.progress);
      }

      async function onEncodingComplete(event: EncodingCompletedEvent) {
        try {
          const file = await remuxVideo(event.file);
          if (shouldSave) {
            saveVideo(file, getFileName());
          }
          setDownloadingState('completed');
          resolve(file);
        } catch (error) {
          setDownloadingState('default');
          reportError(error);
          reject(error);
        } finally {
          video?.removeEventListener('encodingCompleted', onEncodingComplete);
          video?.removeEventListener(
            'encodingStateUpdate',
            onEncodingStateUpdate,
          );
        }
      }

      video?.addEventListener('encodingStateUpdate', onEncodingStateUpdate);
      video?.addEventListener('encodingCompleted', onEncodingComplete);

      if (downloadingState === 'default' || downloadingState === 'completed') {
        setDownloadingState('started');
        video?.pause();
        video?.encode();
      }
    });
  }

  function saveVideo(file: MP4ArrayBuffer, fileName: string) {
    const blob = new Blob([file], {type: 'video/mp4'});
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    document.body.appendChild(a);
    a.setAttribute('href', url);
    a.setAttribute('download', fileName);
    a.setAttribute('target', '_self');
    a.click();
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  }

  async function remuxVideo(file: MP4ArrayBuffer): Promise<MP4ArrayBuffer> {
    const response = await fetch(`${VIDEO_API_ENDPOINT}/remux_video`, {
      body: new Blob([file], {type: 'video/mp4'}),
      method: 'POST',
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to remux video: ${response.status} ${errorText}`,
      );
    }
    const buffer = (await response.arrayBuffer()) as MP4ArrayBuffer;
    buffer.fileStart = 0;
    return buffer;
  }

  return {download, progress, state: downloadingState};
}
