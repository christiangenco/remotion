import path from 'path';
import type {ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {
	CompositionManagerContext,
	TCompMetadata,
	TComposition,
	TimelineContextValue,
} from 'remotion';
import {Internals} from 'remotion';
import {makeDownloadMap} from './assets/download-map';
import {compose} from './compositor/compose';
import {releaseCompositorWithId} from './compositor/compositor';
import {getFrameOutputFileName} from './get-frame-padded-index';
import {Pool} from './pool';
import {stitchFramesToVideo} from './stitch-frames-to-video';

export const renderOnServer = async (
	Comp: ComponentType,
	composition: TCompMetadata
) => {
	console.time('total');
	console.time('frames');
	process.env.REMOTION_SERVER_RENDERING = 'true';
	process.env.SELECT_COMP_ID = composition.id;

	// eslint-disable-next-line react/jsx-no-constructed-context-values
	const memo: CompositionManagerContext = {
		assets: [],
		compositions: [composition as unknown as TComposition<unknown>],
		currentComposition: composition.id,
		currentCompositionMetadata: composition,
		folders: [],
		registerAsset: () => {
			throw new Error('Not implemented');
		},
		registerComposition: () => {
			throw new Error('Not implemented');
		},
		registerFolder: () => {
			throw new Error('Not implemented');
		},
		setCurrentComposition: () => {
			throw new Error('Not implemented');
		},
		registerSequence() {
			throw new Error('Not implemented');
		},
		sequences: [],
		setCurrentCompositionMetadata: () => {
			throw new Error('Not implemented');
		},
		unregisterAsset: () => {
			throw new Error('Not implemented');
		},
		unregisterComposition: () => {
			throw new Error('Not implemented');
		},
		unregisterFolder: () => {
			throw new Error('Not implemented');
		},
		unregisterSequence: () => {
			throw new Error('Not implemented');
		},
	};

	const pool = new Pool(new Array(4).fill(true).map((_, i) => i));

	const downloadMap = makeDownloadMap();

	const renderId = 'abc';

	await Promise.all(
		new Array(composition.durationInFrames).fill(true).map(async (_, i) => {
			const frame = await pool.acquire();
			// eslint-disable-next-line react/jsx-no-constructed-context-values
			const value: TimelineContextValue = {
				audioAndVideoTags: {current: []},
				rootId: composition.id,
				playing: false,
				playbackRate: 1,
				imperativePlaying: {
					current: false,
				},
				frame: i,
				setPlaybackRate: () => {
					throw new Error('Not implemented');
				},
			};

			const svg = renderToStaticMarkup(
				<Internals.Timeline.TimelineContext.Provider value={value}>
					<Internals.CompositionManager.Provider value={memo}>
						<Comp />
					</Internals.CompositionManager.Provider>
				</Internals.Timeline.TimelineContext.Provider>
			);

			const out = path.join(
				downloadMap.compositingDir,
				getFrameOutputFileName({
					frame: i,
					imageFormat: 'tiff',
					index: i,
					countType: 'from-zero',
					lastFrame: composition.durationInFrames - 1,
					totalFrames: composition.durationInFrames,
				})
			);

			await compose({
				height: composition.height,
				width: composition.width,
				downloadMap,
				imageFormat: 'Tiff',
				layers: [
					{
						type: 'SvgImage',
						params: {
							height: composition.height,
							width: composition.width,
							markup: svg,
							x: 0,
							y: 0,
						},
					},
				],
				output: out,
				renderId,
			});

			pool.release(frame);
		})
	);
	releaseCompositorWithId(renderId);
	console.timeEnd('frames');

	await stitchFramesToVideo({
		assetsInfo: {
			assets: [],
			downloadMap,
			firstFrameIndex: 0,
			imageSequenceName: path.join(
				downloadMap.compositingDir,
				`element-%0${3}d.tiff`
			),
		},
		force: true,
		fps: 30,
		height: composition.height,
		width: composition.width,
		outputLocation: path.join(downloadMap.compositingDir, 'out.mp4'),
	});
	console.log(downloadMap.compositingDir);
	// cleanDownloadMap(downloadMap);
	console.timeEnd('total');
};