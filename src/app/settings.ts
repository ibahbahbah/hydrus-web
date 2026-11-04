import { HydrusSearchTag, HydrusSearchTags } from "./hydrus-tags";
import { HydrusService } from "./hydrus-services";
import { SettingsThemeVariant } from "./theme/theme";

export interface AppSettingsV1 {
  version: 1;
  browseSearchOnLoad: boolean;
  browseSearchWhenEmpty: boolean;
  browseDefaultSearchTags: HydrusSearchTags;
  favoriteTags: HydrusSearchTags;
  hyshareUrl: string;
  saucenaoApiKey: string;
  saucenaoSearchProxy: string;
  ipfsMultihashUrlPrefix: string;
  photopeaIntegration: boolean;
  sendDefaultPage: string;
  sendResetFormAfterSend: boolean;
  sendFixDiscordUrls: boolean;
  uploadFilenameTagService: string;
  mediaAutoplay: boolean;
  mediaAutoFullscreen: boolean;
  mediaControls: boolean;
  mediaLoop: boolean;
  mediaDefaultMuted: boolean;
  themeEnabled: boolean;
  themeColor: string;
  themeVariant: SettingsThemeVariant;
  sendViews: boolean;
  doubleTapTag: HydrusSearchTags;
  doubleTapServiceKey: string;
  quickTags: HydrusSearchTags;
  quickTagServiceKey: string;
}

export type AppSettingsStorage = AppSettingsV1;
export type AppSettings = Omit<AppSettingsStorage, "version">;

export const defaultAppSettings: AppSettings = {
  browseSearchOnLoad: true,
  browseSearchWhenEmpty: true,
  browseDefaultSearchTags: ["system:limit is 256"],
  // favoriteTags: ["system:rating for favourites is like", "system:no rating for favourites", "system:ratio is portrait"],
  favoriteTags: [
    "system:ratio taller than 4:3", 
    "system:ratio taller than 3:2", 
    "system:filetype is image", 
    "system:filetype is video", 
    "system:filetype is animation", 
    "system:ratio is portrait",
    "rating:like",
    "rating:like like",
    "rating:favourite",
  ],
  hyshareUrl: '',
  saucenaoApiKey: '',
  saucenaoSearchProxy: '/__saucenao-search',
  ipfsMultihashUrlPrefix: 'https://ipfs.io/ipfs/',
  photopeaIntegration: false,
  sendDefaultPage: '',
  sendResetFormAfterSend: true,
  sendFixDiscordUrls: false,
  uploadFilenameTagService: '',
  mediaAutoplay: true,
  mediaAutoFullscreen: true,
  mediaControls: false,
  mediaLoop: true,
  mediaDefaultMuted: false,
  themeEnabled: false,
  themeColor: '#3f51b5',
  themeVariant: SettingsThemeVariant.DEFAULT,
  sendViews: true,
  doubleTapTag: ['rating:like'],
  doubleTapServiceKey: '',
  quickTags: [],
  quickTagServiceKey: '',
}
