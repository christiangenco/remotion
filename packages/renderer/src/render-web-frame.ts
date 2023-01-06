import path from 'path';
import type {SmallTCompMetadata, TAsset} from 'remotion/src';
import type {RenderMediaOnDownload} from './assets/download-and-map-assets-to-file';
import {downloadAndMapAssetsToFileUrl} from './assets/download-and-map-assets-to-file';
import type {DownloadMap} from './assets/download-map';
import {DEFAULT_BROWSER} from './browser';
import type {BrowserExecutable} from './browser-executable';
import type {BrowserLog} from './browser-log';
import type {Page} from './browser/BrowserPage';
import type {ConsoleMessage} from './browser/ConsoleMessage';
import {compressAsset} from './compress-assets';
import {handleJavascriptException} from './error-handling/handle-javascript-exception';
import type {CountType} from './get-frame-padded-index';
import {getFrameOutputFileName} from './get-frame-padded-index';
import type {ServeUrl} from './legacy-webpack-config';
import {isUserCancelledRender} from './make-cancel-signal';
import type {ChromiumOptions} from './open-browser';
import {openBrowser} from './open-browser';
import {startPerfMeasure, stopPerfMeasure} from './perf';
import type {Pool} from './pool';
import {puppeteerEvaluateWithCatch} from './puppeteer-evaluate';
import type {BrowserReplacer} from './replace-browser';
import {seekToFrame} from './seek-to-frame';
import {setPropsAndEnv} from './set-props-and-env';
import {takeFrameAndCompose} from './take-frame-and-compose';
import {truthy} from './truthy';

const renderFrameWithOptionToReject = async ({
	frame,
	index,
	reject,
	width,
	height,
	poolPromise,
	stopState,
	outputDir,
	onFrameBuffer,
	imageFormat,
	downloadMap,
	onFrameUpdate,
	scale,
	assets,
	countType,
	quality,
	framesToRender,
	lastFrame,
	framesRendered,
	onDownload,
	onError,
}: {
	frame: number;
	index: number;
	reject: (err: Error) => void;
	width: number;
	height: number;
	poolPromise: Promise<Pool<Page>>;
	stopState: {isStopped: boolean};
	outputDir: string | null;
	onFrameBuffer: ((buffer: Buffer, frame: number) => void) | undefined;
	imageFormat: 'png' | 'jpeg' | 'none';
	downloadMap: DownloadMap;
	onFrameUpdate: (
		framesRendered: number,
		frameIndex: number,
		timeToRenderInMilliseconds: number
	) => void;
	scale: number;
	assets: TAsset[][];
	countType: CountType;
	quality: number | undefined;
	framesToRender: number[];
	lastFrame: number;
	framesRendered: {
		frames: number;
	};
	onDownload: RenderMediaOnDownload;
	onError: (err: Error) => void;
}) => {
	const pool = await poolPromise;
	const freePage = await pool.acquire();

	if (stopState.isStopped) {
		return reject(new Error('Render was stopped'));
	}

	const startTime = performance.now();

	const errorCallbackOnFrame = (err: Error) => {
		reject(err);
	};

	const cleanupPageError = handleJavascriptException({
		page: freePage,
		onError: errorCallbackOnFrame,
		frame,
	});
	freePage.on('error', errorCallbackOnFrame);
	await seekToFrame({frame, page: freePage});

	if (!outputDir && !onFrameBuffer && imageFormat !== 'none') {
		throw new Error(
			'Called renderFrames() without specifying either `outputDir` or `onFrameBuffer`'
		);
	}

	if (outputDir && onFrameBuffer && imageFormat !== 'none') {
		throw new Error(
			'Pass either `outputDir` or `onFrameBuffer` to renderFrames(), not both.'
		);
	}

	const id = startPerfMeasure('save');

	const frameDir = outputDir ?? downloadMap.compositingDir;

	const {buffer, collectedAssets} = await takeFrameAndCompose({
		frame,
		freePage,
		height,
		imageFormat,
		output: path.join(
			frameDir,
			getFrameOutputFileName({
				frame,
				imageFormat,
				index,
				countType,
				lastFrame,
				totalFrames: framesToRender.length,
			})
		),
		quality,
		width,
		scale,
		downloadMap,
		wantsBuffer: Boolean(onFrameBuffer),
	});
	if (onFrameBuffer) {
		if (!buffer) {
			throw new Error('unexpected null buffer');
		}

		onFrameBuffer(buffer, frame);
	}

	stopPerfMeasure(id);

	const compressedAssets = collectedAssets.map((asset) =>
		compressAsset(assets.filter(truthy).flat(1), asset)
	);
	assets[index] = compressedAssets;
	compressedAssets.forEach((asset) => {
		downloadAndMapAssetsToFileUrl({
			asset,
			onDownload,
			downloadMap,
		}).catch((err) => {
			onError(
				new Error(`Error while downloading asset: ${(err as Error).stack}`)
			);
		});
	});
	framesRendered.frames++;
	onFrameUpdate(framesRendered.frames, frame, performance.now() - startTime);
	cleanupPageError();
	freePage.off('error', errorCallbackOnFrame);
	pool.release(freePage);
};

const renderWebFrame = ({
	frame,
	index,
	downloadMap,
	imageFormat,
	onFrameBuffer,
	onFrameUpdate,
	outputDir,
	poolPromise,
	stopState,
	composition,
	assets,
	countType,
	scale,
	quality,
	lastFrame,
	framesToRender,
	framesRendered,
	onDownload,
	onError,
}: {
	frame: number;
	index: number;
	downloadMap: DownloadMap;
	imageFormat: 'png' | 'jpeg' | 'none';
	onFrameBuffer: ((buffer: Buffer, frame: number) => void) | undefined;
	onFrameUpdate: (
		framesRendered: number,
		frameIndex: number,
		timeToRenderInMilliseconds: number
	) => void;
	outputDir: string | null;
	poolPromise: Promise<Pool<Page>>;
	stopState: {
		isStopped: boolean;
	};
	composition: SmallTCompMetadata;
	assets: TAsset[][];
	countType: CountType;
	scale: number;
	quality: number | undefined;
	framesToRender: number[];
	lastFrame: number;
	framesRendered: {
		frames: number;
	};
	onDownload: RenderMediaOnDownload;
	onError: (err: Error) => void;
}) => {
	return new Promise<void>((resolve, reject) => {
		renderFrameWithOptionToReject({
			frame,
			index,
			reject,
			width: composition.width,
			height: composition.height,
			downloadMap,
			imageFormat,
			onFrameBuffer,
			onFrameUpdate,
			outputDir,
			poolPromise,
			stopState,
			assets,
			countType,
			scale,
			quality,
			framesToRender,
			lastFrame,
			framesRendered,
			onDownload,
			onError,
		})
			.then(() => {
				resolve();
			})
			.catch((err) => {
				reject(err);
			});
	});
};

export const renderWebFrameAndRetryTargetClose = async ({
	frame,
	index,
	retriesLeft,
	attempt,
	actualConcurrency,
	browserReplacer,
	poolPromise,
	composition,
	downloadMap,
	imageFormat,
	onFrameBuffer,
	onFrameUpdate,
	outputDir,
	stopState,
	assets,
	countType,
	scale,
	quality,
	framesToRender,
	lastFrame,
	framesRendered,
	browserExecutable,
	chromiumOptions,
	dumpBrowserLogs,
	pagesArray,
	onBrowserLog,
	inputProps,
	envVariables,
	muted,
	proxyPort,
	realFrameRange,
	serveUrl,
	timeoutInMilliseconds,
	onDownload,
	onError,
}: {
	frame: number;
	index: number;
	retriesLeft: number;
	attempt: number;
	actualConcurrency: number;
	browserReplacer: BrowserReplacer | null;
	poolPromise: Promise<Pool<Page>>;
	composition: SmallTCompMetadata;
	downloadMap: DownloadMap;
	imageFormat: 'png' | 'jpeg' | 'none';
	onFrameBuffer: ((buffer: Buffer, frame: number) => void) | undefined;
	onFrameUpdate: (
		framesRendered: number,
		frameIndex: number,
		timeToRenderInMilliseconds: number
	) => void;
	outputDir: string | null;
	stopState: {
		isStopped: boolean;
	};
	assets: TAsset[][];
	countType: CountType;
	scale: number;
	quality: number | undefined;
	framesToRender: number[];
	lastFrame: number;
	framesRendered: {
		frames: number;
	};
	browserExecutable?: BrowserExecutable;
	chromiumOptions?: ChromiumOptions;
	dumpBrowserLogs?: boolean;
	pagesArray: Page[];
	onBrowserLog?: (log: BrowserLog) => void;
	inputProps: unknown;
	envVariables?: Record<string, string>;
	muted: boolean;
	proxyPort: number;
	realFrameRange: [number, number];
	serveUrl: ServeUrl;
	timeoutInMilliseconds: number;
	onDownload: RenderMediaOnDownload;
	onError: (err: Error) => void;
}) => {
	try {
		await renderWebFrame({
			frame,
			index,
			poolPromise,
			composition,
			downloadMap,
			imageFormat,
			onFrameBuffer,
			onFrameUpdate,
			outputDir,
			stopState,
			assets,
			countType,
			scale,
			quality,
			framesToRender,
			lastFrame,
			framesRendered,
			onDownload,
			onError,
		});
	} catch (err) {
		if (
			!(err as Error)?.message?.includes('Target closed') &&
			!(err as Error)?.message?.includes('Session closed')
		) {
			throw err;
		}

		if (isUserCancelledRender(err)) {
			throw err;
		}

		if (retriesLeft === 0) {
			console.warn(
				err,
				`The browser crashed ${attempt} times while rendering frame ${frame}. Not retrying anymore. Learn more about this error under https://www.remotion.dev/docs/target-closed`
			);
			throw err;
		}

		console.warn(
			`The browser crashed while rendering frame ${frame}, retrying ${retriesLeft} more times. Learn more about this error under https://www.remotion.dev/docs/target-closed`
		);
		if (!browserReplacer) {
			throw new Error('Did not have browser replacer for web frame');
		}

		await browserReplacer.replaceBrowser(
			() =>
				makeBrowser({
					browserExecutable,
					chromiumOptions,
					dumpBrowserLogs,
					scale,
				}),
			async () => {
				const pages = new Array(actualConcurrency).fill(true).map(() =>
					makePage({
						browserReplacer,
						composition,
						pagesArray,
						onBrowserLog,
						scale,
						inputProps,
						envVariables,
						imageFormat,
						muted,
						proxyPort,
						realFrameRange,
						serveUrl,
						timeoutInMilliseconds,
					})
				);
				const puppeteerPages = await Promise.all(pages);
				const pool = await poolPromise;
				for (const newPage of puppeteerPages) {
					pool.release(newPage);
				}
			}
		);
		await renderWebFrameAndRetryTargetClose({
			frame,
			index,
			retriesLeft: retriesLeft - 1,
			attempt: attempt + 1,
			actualConcurrency,
			browserReplacer,
			composition,
			downloadMap,
			imageFormat,
			onFrameBuffer,
			onFrameUpdate,
			outputDir,
			poolPromise,
			stopState,
			assets,
			countType,
			scale,
			quality,
			framesToRender,
			lastFrame,
			framesRendered,
			inputProps,
			pagesArray,
			browserExecutable,
			chromiumOptions,
			dumpBrowserLogs,
			envVariables,
			muted,
			onBrowserLog,
			proxyPort,
			realFrameRange,
			serveUrl,
			timeoutInMilliseconds,
			onDownload,
			onError,
		});
	}
};

export const makePage = async ({
	browserReplacer,
	pagesArray,
	composition,
	scale,
	onBrowserLog,
	inputProps,
	envVariables,
	serveUrl,
	realFrameRange,
	timeoutInMilliseconds,
	proxyPort,
	imageFormat,
	muted,
}: {
	browserReplacer: BrowserReplacer;
	pagesArray: Page[];
	composition: SmallTCompMetadata;
	scale?: number;
	onBrowserLog?: (log: BrowserLog) => void;
	inputProps: unknown;
	envVariables?: Record<string, string>;
	serveUrl: ServeUrl;
	realFrameRange: [number, number];
	timeoutInMilliseconds: number | undefined;
	proxyPort: number;
	imageFormat: 'png' | 'jpeg' | 'none';
	muted: boolean;
}) => {
	if (!browserReplacer) {
		throw new Error('canonot make page without browser replacer');
	}

	const page = await browserReplacer.getBrowser().newPage();
	pagesArray.push(page);
	await page.setViewport({
		width: composition.width,
		height: composition.height,
		deviceScaleFactor: scale ?? 1,
	});

	const logCallback = (log: ConsoleMessage) => {
		onBrowserLog?.({
			stackTrace: log.stackTrace(),
			text: log.text,
			type: log.type,
		});
	};

	if (onBrowserLog) {
		page.on('console', logCallback);
	}

	const initialFrame = realFrameRange[0];

	await setPropsAndEnv({
		inputProps,
		envVariables,
		page,
		serveUrl,
		initialFrame,
		timeoutInMilliseconds,
		proxyPort,
		retriesRemaining: 2,
		audioEnabled: !muted,
		videoEnabled: imageFormat !== 'none',
	});

	await puppeteerEvaluateWithCatch({
		// eslint-disable-next-line max-params
		pageFunction: (
			id: string,
			defaultProps: unknown,
			durationInFrames: number,
			fps: number,
			height: number,
			width: number
		) => {
			window.setBundleMode({
				type: 'composition',
				compositionName: id,
				compositionDefaultProps: defaultProps,
				compositionDurationInFrames: durationInFrames,
				compositionFps: fps,
				compositionHeight: height,
				compositionWidth: width,
			});
		},
		args: [
			composition.id,
			composition.defaultProps,
			composition.durationInFrames,
			composition.fps,
			composition.height,
			composition.width,
		],
		frame: null,
		page,
	});

	page.off('console', logCallback);

	return page;
};

export const makeBrowser = ({
	dumpBrowserLogs,
	browserExecutable,
	chromiumOptions,
	scale,
}: {
	dumpBrowserLogs?: boolean | undefined;
	browserExecutable?: BrowserExecutable | undefined;
	chromiumOptions?: ChromiumOptions | undefined;
	scale?: number | undefined;
}) =>
	openBrowser(DEFAULT_BROWSER, {
		shouldDumpIo: dumpBrowserLogs,
		browserExecutable,
		chromiumOptions,
		forceDeviceScaleFactor: scale ?? 1,
	});