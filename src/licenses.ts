/** What `corgi licenses` prints: Corgi's license, then the notices of the software it includes. */
import corgi from "../LICENSE" with { type: "text" };
import thirdParty from "../assets/licenses.txt" with { type: "text" };
import herdrSounds from "../assets/sounds/LICENSE" with { type: "text" };
import fastRsync from "./fast_rsync.LICENSE" with { type: "text" };

export const text = `Corgi\n=====\n\n${corgi}\n\n${thirdParty}${herdrSounds}\n\nfast_rsync (Bun port)\n====================\nCopyright (c) 2019 Dropbox, Inc.\nCopyright (c) 2016 bacher09, Artyom Pavlov.\nPorted and modified for Bun by Corgi contributors, 2026.\nhttps://github.com/dropbox/fast_rsync\n\n${fastRsync}`;
