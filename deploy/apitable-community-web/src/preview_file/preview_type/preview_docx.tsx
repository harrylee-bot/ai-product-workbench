import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isPrivateDeployment, Strings, t } from '@apitable/core';
import { Loading } from './preview_doc/loading';
import { IPreviewTypeBase } from './preview_type.interface';
import { getDownloadSrc, getPreviewUrl, renderFileIconUrl } from 'pc/utils';

declare global {
  interface Window {
    JSZip?: unknown;
    docx?: {
      renderAsync: (
        data: Blob,
        bodyContainer: HTMLElement,
        styleContainer?: HTMLElement,
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }
}

const loadScript = (src: string, ready: () => boolean) => {
  if (ready()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Unable to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Unable to load ${src}`));
    document.head.appendChild(script);
  });
};

const getAttachmentUrl = (token: string) => {
  if (!isPrivateDeployment() || !token.startsWith('/')) {
    return token;
  }
  return `${window.location.origin}${token}`;
};

export const PreviewDocx: React.FC<React.PropsWithChildren<IPreviewTypeBase>> = ({ file, disabledDownload }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const { bucket, token } = file;
  const attachmentUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    return getAttachmentUrl(getPreviewUrl({ bucket, token } as typeof file));
  }, [bucket, token]);

  useEffect(() => {
    if (!attachmentUrl) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const render = async () => {
      try {
        setLoading(true);
        setError(false);
        const publicUrl = (path: string) => new URL(path, window.location.origin).href;
        await loadScript(publicUrl('/file/jszip.min.js'), () => Boolean(window.JSZip));
        await loadScript(publicUrl('/file/docx-preview.js'), () => Boolean(window.docx?.renderAsync));

        const response = await fetch(attachmentUrl, { credentials: 'include', signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Attachment request failed: ${response.status}`);
        }
        const blob = await response.blob();
        if (cancelled || !bodyRef.current || !styleRef.current || !window.docx) {
          return;
        }

        await window.docx.renderAsync(blob, bodyRef.current, styleRef.current, {
          breakPages: true,
          inWrapper: true,
          renderHeaders: true,
          renderFooters: true,
          useBase64URL: true,
        });
        if (!cancelled) {
          setLoading(false);
        }
      } catch (renderError) {
        if ((renderError as Error).name === 'AbortError') {
          return;
        }
        if (!cancelled) {
          setLoading(false);
          setError(true);
        }
      }
    };

    render();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attachmentUrl]);

  if (error) {
    const icon = renderFileIconUrl({ name: file.name, type: file.mimeType });
    return (
      <div
        onMouseDown={(event) => event.stopPropagation()}
        style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8' }}
      >
        <div style={{ textAlign: 'center', color: '#626873' }}>
          <img src={icon.src} alt="" style={{ width: 72, height: 72 }} />
          <p style={{ margin: '16px 0 12px' }}>DOCX 文件预览失败</p>
          {!disabledDownload && (
            <a href={getDownloadSrc(file)} download={file.name} style={{ color: '#5b4ae8' }}>
              {t(Strings.download)}
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      onMouseDown={(event) => event.stopPropagation()}
      style={{ height: '100%', overflow: 'auto', background: '#eef0f3', padding: 24 }}
    >
      {loading && <Loading tip={t(Strings.loading_file)} />}
      <div ref={styleRef} />
      <div ref={bodyRef} />
    </div>
  );
};
