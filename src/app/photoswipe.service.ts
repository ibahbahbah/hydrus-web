import { ApplicationRef, EnvironmentInjector, Injectable, createComponent, ComponentRef } from '@angular/core';
import { HydrusBasicFile, FileCategory, TagStatus } from './hydrus-file';
import PhotoSwipe, { PhotoSwipeOptions, SlideData } from 'photoswipe';
import { Platform } from '@angular/cdk/platform';
import Content from 'photoswipe/dist/types/slide/content';
import Slide from 'photoswipe/dist/types/slide/slide';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { FileInfoSheetComponent } from './file-info-sheet/file-info-sheet.component';
import { TagInputDialogComponent } from './tag-input-dialog/tag-input-dialog.component';
import { QuickTagDialogComponent } from './quick-tag-dialog/quick-tag-dialog.component';
import { HydrusSearchTags } from './hydrus-tags';
import { Location } from '@angular/common';
import { firstValueFrom, map, take, of, catchError, shareReplay } from 'rxjs';
import { canOpenInPhotopea, getPhotopeaUrlForFile } from './photopea';
import { SettingsService } from './settings.service';
import { MatButton } from '@angular/material/button';
import { ThemeService } from './theme/theme.service';
import { ErrorService } from './error.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { HydrusTagsService } from './hydrus-tags.service';
import { HydrusViewsService } from './hydrus-views.service';
import { HydrusRatingsService } from './hydrus-ratings.service';
import { HydrusServiceType } from './hydrus-services';
import { HydrusFilesService } from './hydrus-files.service';
import { HydrusFileDownloadService } from './hydrus-file-download.service';
import { serializeError } from 'serialize-error';


function isContentType(content: Content | Slide, type: string) {
  return (content && content.data && content.data.type === type);
}

function flattenSearchTags(tags: HydrusSearchTags): string[] {
  const flat = tags.flatMap(tag => typeof tag === 'string' ? [tag] : flattenSearchTags(tag));
  return Array.from(new Set(flat.filter(tag => tag.trim().length > 0)));
}

@Injectable({
  providedIn: 'root'
})
export class PhotoswipeService {
  constructor(
    public platform: Platform,
    private bottomSheet: MatBottomSheet,
    private dialog: MatDialog,
    private location: Location,
    private settingsService: SettingsService,
    private appRef: ApplicationRef,
    private snackbar: MatSnackBar,
    private injector: EnvironmentInjector,
    private themeService: ThemeService,
    private errorService: ErrorService,
    private viewsService: HydrusViewsService,
    private filesService: HydrusFilesService,
    private tagsService: HydrusTagsService,
    private ratingsService: HydrusRatingsService,
    private downloadService: HydrusFileDownloadService,
  ) { }

  private readonly contentComponentRefs = new WeakMap<Content, ComponentRef<MatButton>[]>();

  // For some reason adding this fixes the issue of the icon ordering bug
  likeService$ = this.ratingsService.ratingServices$.pipe(
    take(1),
    map(services => services.find(service => 
      service.type === HydrusServiceType.LOCAL_RATING_LIKE || 
      service.type === HydrusServiceType.RATING_LIKE_REPOSITORY
    )),
    catchError(() => of(undefined)),
    shareReplay({ bufferSize: 1, refCount: false }),
  ).subscribe()

  private static readonly MAX_PROCESSED_FILES = 100;
  private readonly processedFiles = new Map<string, SlideData>();

  private cacheProcessedFile(hash: string, slideData: SlideData) {
    // Refresh insertion order so this behaves like an LRU.
    this.processedFiles.delete(hash);
    this.processedFiles.set(hash, slideData);

    while (this.processedFiles.size > PhotoswipeService.MAX_PROCESSED_FILES) {
      const oldestKey = this.processedFiles.keys().next().value;
      if (oldestKey === undefined) break;
      this.processedFiles.delete(oldestKey);
    }
  }

  private activePhotoSwipe?: PhotoSwipe;
  private pswpHistoryId = 0;

  private overlayOpen = false;
  private quickTagDialogRef?: MatDialogRef<QuickTagDialogComponent>;

  private async openQuickTagDialog(pswp: PhotoSwipe) {
    if (this.overlayOpen) {
      return;
    }

    const file = pswp.currSlide?.data.file as HydrusBasicFile | undefined;
    if (!file) {
      return;
    }

    const { quickTags, quickTagServiceKey } = this.settingsService.appSettings;
    const tags = flattenSearchTags(quickTags);

    if (!quickTagServiceKey || tags.length === 0) {
      this.snackbar.open('Set up quick tags in Settings first.', undefined, {
        duration: 3000
      });
      return;
    }

    this.overlayOpen = true;

    let existingTags: string[] = [];
    try {
      const metadata = await firstValueFrom(this.filesService.getFileByHash(file.hash));
      existingTags = metadata.tags?.[quickTagServiceKey]?.storage_tags?.[TagStatus.Current] ?? [];
    } catch (error) {
      this.overlayOpen = false;
      this.errorService.handleHydrusError(error, 'Error loading file tags');
      return;
    }

    // The gallery may have been closed while the metadata request was in flight.
    if (this.activePhotoSwipe !== pswp) {
      this.overlayOpen = false;
      return;
    }

    const dialogRef = QuickTagDialogComponent.open(this.dialog, file, tags, quickTagServiceKey, existingTags);
    this.quickTagDialogRef = dialogRef;
    dialogRef.afterClosed().subscribe(() => {
      this.overlayOpen = false;
      if (this.quickTagDialogRef === dialogRef) {
        this.quickTagDialogRef = undefined;
      }
    });
  }

  openPhotoSwipe(items: HydrusBasicFile[], id: number) {
    if (this.activePhotoSwipe) {
      return; // one gallery at a time
    }

    //
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isPressing = false;           // flag to avoid double triggers
    let longPressFired = false;       // hold threshold reached
    let suppressTap = false;          // suppress the tap that follows a hold
    let startX = 0;                   // track movement distance
    let startY = 0;                   // track movement distance
    const HOLD_DURATION = 450;        // milliseconds
    // const MOVE_THRESHOLD = 10;        // pixels – cancel if finger slides
    const MOVE_THRESHOLD_SQUARED = 10 * 10;

    const cancelLongPressTimer = () => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const cancelLongPress = () => {
      cancelLongPressTimer();
      isPressing = false;
      longPressFired = false;
    };
    
    let viewStartTimestamp = Date.now();
    let lastFile: HydrusBasicFile | undefined;

    const handleView = (file?: HydrusBasicFile) => {
      if(!this.settingsService.appSettings.sendViews) {
        return;
      }
      if(lastFile && lastFile.hash !== file?.hash) {
        const currentTimestamp = Date.now();
        this.viewsService.submitView(lastFile, viewStartTimestamp, currentTimestamp);
        viewStartTimestamp = currentTimestamp;
      }
      lastFile = file;
    }

    this.themeService.addBlackThemeColorMetaTag();

    const files = items.slice(); 
    const index = files.findIndex(file => file.file_id === id);

    if (index === -1) {
      return;
    }

    const options: PhotoSwipeOptions = {
      index,
      dataSource: files,
      bgOpacity: 1,
      clickToCloseNonZoomable: false,
      showHideAnimationType: 'none',
      arrowPrev: false,
      arrowNext: false,
      zoom: false,
      close: false,
      maxZoomLevel: 2,
      errorMsg: 'The file cannot be loaded',
      trapFocus: false,
      preload: [1, 1], // [n, m] Preloads n images after current one and m images after next one. (based on moved direction)
    }

    
    const pswp = new PhotoSwipe(options);

    pswp.addFilter('itemData', itemData => {
      const file = itemData as HydrusBasicFile;
      return this.processedFiles.get(file.hash) ?? this.getPhotoSwipeItem(file);
    });

    pswp.on('wheel', (e) => {
      const event = e.originalEvent;
      if(event.ctrlKey) {
        return;
      }
      e.preventDefault();
      if (event.deltaY < 0) { // wheel up
        pswp.prev();
      } else if (event.deltaY > 0) { // wheel down
        pswp.next();
      }
    });

    // -- Long Press Action --------------------
    pswp.on('pointerDown', (e) => {
      const target = e.originalEvent.target as HTMLElement | null;
      // Don't trigger from toolbar buttons, video controls, links, etc.
      if (target?.closest('.pswp__ui, .pswp__button, button, a, input, select, textarea, video, audio')) {
        return;
      }

      cancelLongPress();
      suppressTap = false;
      startX = e.originalEvent.clientX;
      startY = e.originalEvent.clientY;
      isPressing = true;

      longPressTimer = setTimeout(() => {
        if (!isPressing) return;
        
        longPressFired = true;
        longPressTimer = null;
        navigator.vibrate?.(10);

        suppressTap = true;
        this.openQuickTagDialog(pswp);
      
      }, HOLD_DURATION);

    });

    // -- Cancel Long Press Action on Move --------------------
    pswp.on('pointerMove', (e) => {
      if (!isPressing) return;

      const dx = e.originalEvent.x - startX;
      const dy = e.originalEvent.y - startY;

      if (dx * dx + dy * dy > MOVE_THRESHOLD_SQUARED) {
        cancelLongPress();
      }

    });

    // -- Open Quick Tags on Lift after a Hold --------------------
    pswp.on('pointerUp', () => {
      const shouldOpenQuickTags = longPressFired;
      cancelLongPress();

      if (shouldOpenQuickTags) {
        suppressTap = true;
        this.openQuickTagDialog(pswp);
      }
    });

    pswp.on('tapAction', (e) => {
      if (suppressTap) {
        suppressTap = false;
        e.preventDefault();
        return;
      }
      if(!pswp.currSlide?.content.isImageContent()) {
        e.preventDefault();
      }
    });

    pswp.on('doubleTapAction', async (e) => {
      // Double tap to add tag to current image
      e.preventDefault();
      const file = pswp.currSlide?.content.data.file as HydrusBasicFile;
      const tag = this.settingsService.appSettings.doubleTapTag[0].toString()
      const serviceKey = this.settingsService.appSettings.doubleTapServiceKey.toString()
      // console.log(file.hash, tag, serviceKey)
      try {
        await firstValueFrom(this.tagsService.addTagsToService(file.hash, [tag], serviceKey));
        const snackbarRef = this.snackbar.open(
          `Added tag: '${tag}'`,
          'Undo',
          { duration: 2000 }
        );
        snackbarRef.onAction().subscribe(async () => {
          await firstValueFrom(this.tagsService.deleteTagsFromLocalService(file.hash, [tag], serviceKey))
          this.snackbar.open(
            `Removed tag: '${tag}'`,
            undefined,
            { duration: 2000 }
          );
        })
      } catch (error) {
        this.errorService.displayError(error);
      } 

    });

    pswp.on('bindEvents', () => {
      pswp.scrollWrap.onauxclick = (event: MouseEvent) => {
        if (event.button === 1) {
          pswp.close();
        }
      };
    });

    pswp.on('keydown', (e) => {
      if (this.overlayOpen) {
        e.preventDefault();
      }
    });

    const ratingCache = new Map<string, boolean>();

    /*  */
    pswp.on('uiRegister', () => {

      // like/favorite rating icon 
      this.ratingsService.ratingServices$.pipe(
        take(1),
        map(services => services.find(service => 
          service.type === HydrusServiceType.LOCAL_RATING_LIKE || 
          service.type === HydrusServiceType.RATING_LIKE_REPOSITORY
        ))
      ).subscribe(likeService => { pswp.ui?.registerElement({
          name: 'like-rating',
          order: 10, // Before download button
          isButton: true,
          tagName: 'button',
          html: '<span class="mat-icon material-icons pswp__button--large pswp__icon--large">favorite_outline</span>', // Add large icon class
          onInit: (el, pswp) => {
            // Update icon when slide changes
            pswp.on('change', () => {
              const file = pswp.currSlide?.data.file as HydrusBasicFile;
              this.updateLikeButtonState(file, likeService.service_key, el, ratingCache);
            });
          },
          onClick: async (event, el, pswp) => {
            const file = pswp.currSlide?.data.file as HydrusBasicFile;
            await this.toggleLikeRating(file, likeService, el, ratingCache);
          }
        });
      });

      // info icon: opens file-info-sheet
      pswp.ui?.registerElement({
        name: 'info',
        order: 15,
        isButton: true,
        tagName: 'button',
        html: '<span class="mat-icon material-icons">info_outlined</span>',
        onClick: (event, el, pswp) => {
          const file = pswp.currSlide?.data.file as HydrusBasicFile;
          this.overlayOpen = true;
          FileInfoSheetComponent.open(this.bottomSheet, file)
            .afterDismissed()
            .pipe(take(1))
            .subscribe(res => {
              this.overlayOpen = false;
              if(res) {
                pswp.close();
              }
            });
        }
      });

      // 
      pswp.ui?.registerElement({
        name: 'custom-close',
        order: 20,
        isButton: true,
        tagName: 'button',
        html: '<span class="mat-icon material-icons">close</span>',
        onClick: 'close'
      });

      // //
      // pswp.ui.registerElement({
      //   name: 'download',
      //   order: 13,
      //   isButton: true,
      //   tagName: 'button',
      //   html: '<span class="mat-icon material-icons">get_app</span>',
      //   onClick: (event, el, pswp) => {
      //     const file = pswp.currSlide.data.file as HydrusBasicFile;
      //     this.downloadService.saveFile(file);
      //   }
      // });

      // //
      // if(this.downloadService.canShare) {
      //   pswp.ui.registerElement({
      //     name: 'share',
      //     order: 14,
      //     isButton: true,
      //     tagName: 'button',
      //     html: '<span class="mat-icon material-icons">share</span>',
      //     onClick: (event, el, pswp) => {
      //       const file = pswp.currSlide.data.file as HydrusBasicFile;
      //       this.downloadService.shareFile(file);
      //     }
      //   });
      // }

      // 
      pswp.ui?.registerElement({
        name: 'zoom-level-indicator',
        order: 6,
        className: 'pswp__zoom-level',
        onInit: (el, pswp) => {
          pswp.on('zoomPanUpdate', (e) => {
            if (e.slide === pswp.currSlide )  {
              if(pswp.currSlide.isZoomable()) {
                el.innerText = `${Math.round(pswp.currSlide.currZoomLevel * (window.devicePixelRatio ?? 1) * 100)}%`;
              } else {
                el.innerText = '';
              }
            }
          });
        }
      });
    });


    //
    // pswp.addFilter('uiElement', (element, data) => {
    //   return element;
    // });

    /**/
    pswp.on('contentLoad', (e) => {
      const { content, isLazy } = e;
      const file = content.data.file as HydrusBasicFile;
      // console.log(`Loaded Content: ${file.file_url}`)

      if (isContentType(content, 'video')) {
        e.preventDefault();
        content.state = 'loading';

        content.element = document.createElement('div');
        content.element.className = 'pswp-video-container';

        const placeholder = document.createElement('img');
        placeholder.src = file.thumbnail_url;
        placeholder.className = 'pswp-video-placeholder';
        content.element.append(placeholder);

        const vid = document.createElement('video');
        vid.className = 'pswp-video pswp-media';
        vid.poster = file.thumbnail_url;
        vid.controls = this.settingsService.appSettings.mediaControls;
        vid.loop = this.settingsService.appSettings.mediaLoop;
        vid.muted = this.settingsService.appSettings.mediaDefaultMuted;
        vid.playsInline = true;
        
        vid.preload = isLazy ? 'none' : 'metadata';
        
        vid.addEventListener('loadedmetadata', () => content.onLoaded(), { once: true });
        vid.addEventListener('error', () => content.onError(), { once: true });
        
        vid.src = file.file_url;
        // const video = this.createVideoElement(file, content, isLazy);
        content.element.prepend(vid);

      } else if (isContentType(content, 'audio')) {
        e.preventDefault();

        content.state = 'loading';

        content.element = document.createElement('div');
        content.element.className = 'pswp-audio-container';
      } else if (isContentType(content, 'renderable')) {
        e.preventDefault();
        content.element = document.createElement('div');
        content.element.className = 'pswp__content pswp__error-msg-container';

        const errorMsgEl = document.createElement('div');
        errorMsgEl.className = 'pswp__error-msg';
        content.element.appendChild(errorMsgEl);

        const img = document.createElement('img');
        img.src = file.thumbnail_url;
        img.className = 'pswp-error-thumb';
        errorMsgEl.appendChild(img);

        const errorMsgText = document.createElement('div');
        errorMsgText.innerText = `Unsupported Filetype (${file.file_type_string})`;
        errorMsgText.className = 'pswp-error-text';
        errorMsgEl.appendChild(errorMsgText);

        this.addRenderButton(file, errorMsgEl, pswp, content);

        this.addPhotopeaButton(file, errorMsgEl, content);
      } else if (isContentType(content, 'unsupported')) {
        e.preventDefault();
        content.element = document.createElement('div');
        content.element.className = 'pswp__content pswp__error-msg-container';

        const errorMsgEl = document.createElement('div');
        errorMsgEl.className = 'pswp__error-msg';
        content.element.appendChild(errorMsgEl);

        const img = document.createElement('img');
        img.src = file.thumbnail_url;
        img.className = 'pswp-error-thumb';
        errorMsgEl.appendChild(img);

        const errorMsgText = document.createElement('div');
        errorMsgText.innerText = `Unsupported Filetype (${file.file_type_string})`;
        errorMsgText.className = 'pswp-error-text';
        errorMsgEl.appendChild(errorMsgText);

        this.addPhotopeaButton(file, errorMsgEl, content);
      }

    });

    pswp.on('contentActivate', ({content}) => {
      handleView(content.data.file as HydrusBasicFile);

      const file = content.data.file as HydrusBasicFile;
      // console.log(`Loaded Content: ${file}`)

      if (isContentType(content, 'video') && content.element) {
        let video = content.element.querySelector<HTMLVideoElement>('video.pswp-media');
        
        // Normally created in contentLoad so neighboring slides can preload.
        // Recreate it if PhotoSwipe removed the slide from its DOM cache.
        if (!video) {
          content.state = 'loading';

          video = document.createElement('video');
          video.src = file.file_url;
          video.poster = file.thumbnail_url;
          video.controls = this.settingsService.appSettings.mediaControls;
          video.loop = this.settingsService.appSettings.mediaLoop;
          video.muted = this.settingsService.appSettings.mediaDefaultMuted;
          video.playsInline = !this.settingsService.appSettings.mediaAutoFullscreen;
          video.className = 'pswp-video pswp-media';

          video.addEventListener('loadedmetadata', () => content.onLoaded(), { once: true });
          video.addEventListener('error', () => content.onError(), { once: true });

          // Do not set `autoplay` here: only the active slide should ever play.
          content.element.prepend(video);
        }

        const activeVideo = video;

        // Only the active slide buffers aggressively.
        activeVideo.preload = 'auto';

        if (activeVideo.readyState === HTMLMediaElement.HAVE_NOTHING) {
          activeVideo.load();
        }

        if (this.settingsService.appSettings.mediaAutoplay) {
          activeVideo.play().catch(() => {
            // Browsers block unmuted autoplay; retry muted so playback starts.
            activeVideo.muted = true;
            activeVideo.play().catch(() => {
              // Leave the poster and native controls visible for a manual start.
            });
          });
        }
      } else if (isContentType(content, 'audio') && content.element) {
        let audio = content.element.querySelector<HTMLAudioElement>('audio.pswp-media');
        if (!audio) {
          content.state = 'loading';

          audio = document.createElement('audio');
          audio.src = file.file_url;
          audio.loop = this.settingsService.appSettings.mediaLoop;
          audio.muted = this.settingsService.appSettings.mediaDefaultMuted;
          audio.controls = true;
          audio.className = 'pswp-audio pswp-media';

          audio.addEventListener('loadedmetadata', () => content.onLoaded(), { once: true });
          audio.addEventListener('error', () => content.onError(), { once: true });

          content.element.prepend(audio);
        }

        const activeAudio = audio;

        activeAudio.preload = 'auto';

        if (activeAudio.readyState === HTMLMediaElement.HAVE_NOTHING) {
          activeAudio.load();
        }  

        if (this.settingsService.appSettings.mediaAutoplay) {
          activeAudio.play().catch(() => {
            activeAudio.muted = true;
            activeAudio.play().catch(() => {
              // Leave controls visible for a manual start.
            });
          });
        }
      }
    });

    pswp.addFilter('contentErrorElement', (contentErrorElement, content) => {

      const file = content.data.file as HydrusBasicFile;

      const errorMsgEl = document.createElement('div');
      errorMsgEl.className = 'pswp__error-msg';
      content.element?.appendChild(errorMsgEl);

      const img = document.createElement('img');
      img.src = file.thumbnail_url;
      img.className = 'pswp-error-thumb';
      errorMsgEl.appendChild(img);

      const errorMsgText = document.createElement('div');
      errorMsgText.innerText = `The file cannot be loaded (${file.file_type_string})`;
      errorMsgText.className = 'pswp-error-text';
      errorMsgEl.appendChild(errorMsgText);

      if(file.render_url) {
        this.addRenderButton(file, errorMsgEl, pswp, content);
      }

      return errorMsgEl;
    });

    // pswp.on('appendHeavy', (e) => {

    // });

    // pswp.on('contentAppend', (e) => {

    // });
    
    // Keep the element and buffer alive
    const pauseMedia = (content: Content) => {
      content.element
      ?.querySelectorAll<HTMLMediaElement>('.pswp-media')
      .forEach(media => media.pause());
    };
    
    pswp.on('contentDeactivate', ({content}) => {
      pauseMedia(content);
    });
    
    // 
    const handleDestroyMedia = (content: Content) => {
      if ((isContentType(content, 'video') || isContentType(content, 'audio')) && content.element) {
        content.element.querySelectorAll<HTMLMediaElement>('.pswp-media').forEach(media => {
          media.pause();
          media.removeAttribute('src');
          media.load();
          media.remove();
        })
      }
    }
    
    pswp.on('contentRemove', ({content}) => {
      handleDestroyMedia(content);
    });
    
    pswp.on('contentDestroy', ({content}) => {
      this.destroyContentComponents(content);
    });

    const historyId = ++this.pswpHistoryId;
    const locSub = this.location.subscribe(() => pswp.close());

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;

      cancelLongPress();
      this.overlayOpen = false;
      this.quickTagDialogRef?.close();
      handleView();
      this.themeService.removeBlackThemeColorMetaTag();
      locSub.unsubscribe();

      if (this.activePhotoSwipe === pswp) {
        this.activePhotoSwipe = undefined;
      }
    };

    pswp.on('close', () => {
      cleanup();
    });
    
    pswp.on('destroy', cleanup)

    window.history.pushState({ pswpId: historyId }, '');
    this.activePhotoSwipe = pswp;

    try {
      pswp.init();
    } catch (error) {
      cleanup();
      if (window.history.state?.pswpId === historyId) {
        window.history.back();
      }
      throw error;
    }

  }

  getPhotoSwipeItem(file: HydrusBasicFile): SlideData {

    switch(file.file_category) {
      case FileCategory.Image: {
        return {
          src: file.file_url,
          msrc: file.thumbnail_url,
          width: file.width,
          height: file.height,
          file
        };
      }
      case FileCategory.Video: {
        return {
          file,
          type: 'video',
          width: file.width,
          height: file.height,
          msrc: file.thumbnail_url,
        };
      }
      case FileCategory.Audio: {
        return {
          file,
          type: 'audio'
        };
      }
      case FileCategory.Renderable: {
        return {
          file,
          type: 'renderable',
          width: file.width,
          height: file.height
        };
      }
      default: {
        return {
          type: 'unsupported',
          file
        };
      }
    }
  }

  private trackContentComponent(content: Content, ref: ComponentRef<MatButton>) {
    const refs = this.contentComponentRefs.get(content);
    if (refs) {
      refs.push(ref);
    } else {
      this.contentComponentRefs.set(content, [ref]);
    }
    this.appRef.attachView(ref.hostView);
  }

  private destroyContentComponents(content: Content) {
    const refs = this.contentComponentRefs.get(content);
    if (!refs) return;

    for (const ref of refs) {
      this.appRef.detachView(ref.hostView);
      ref.destroy();
    }
    this.contentComponentRefs.delete(content);
  }

  private addPhotopeaButton(file: HydrusBasicFile, element: HTMLElement, content: Content) {
    if(canOpenInPhotopea(file) && this.settingsService.appSettings.photopeaIntegration) {
      const photopeaButton = document.createElement('a');
      photopeaButton.setAttribute('mat-stroked-button', '');
      photopeaButton.target = '_blank';
      photopeaButton.href = getPhotopeaUrlForFile(file);

      const photopeaButtonComponent = createComponent(MatButton, {
        environmentInjector: this.injector,
        hostElement: photopeaButton,
        projectableNodes: [
          [document.createTextNode('Open file in Photopea')]
        ]
      })

      const buttonContainer = document.createElement('div');
      buttonContainer.className = 'pswp-error-text';
      element.appendChild(buttonContainer);
      buttonContainer.appendChild(photopeaButton);

      // this.appRef.attachView(photopeaButtonComponent.hostView);
      this.trackContentComponent(content, photopeaButtonComponent);
    }
  }

  private addRenderButton(file: HydrusBasicFile, element: HTMLElement, pswp: PhotoSwipe, content: Content) {
    const renderButton = document.createElement('button');
      renderButton.setAttribute('mat-stroked-button', '');
      const psdButtonComponent = createComponent(MatButton, {
        environmentInjector: this.injector,
        hostElement: renderButton,
        projectableNodes: [
          [document.createTextNode('Load render from Hydrus')]
        ]
      })

      const buttonContainer = document.createElement('div');
      buttonContainer.className = 'pswp-error-text';
      element.appendChild(buttonContainer);
      buttonContainer.appendChild(renderButton);
      
      this.appRef.attachView(psdButtonComponent.hostView);

      renderButton.addEventListener('click', async (ev) => {
        psdButtonComponent.setInput('disabled', true);
        const data = {
          type: 'image',
          src: file.render_url,
          msrc: file.thumbnail_url,
          width: file.width,
          height: file.height,
          file
        }
        this.cacheProcessedFile(file.hash, data);
        pswp.refreshSlideContent(content.index);
      })
  }

  private async getCurrentRating(file: HydrusBasicFile, serviceKey: string): Promise<boolean> {
    try {
      const fileInfo = await firstValueFrom(this.filesService.getFileByHash(file.hash));
      if ('ratings_array' in fileInfo && Array.isArray(fileInfo.ratings_array)) {
        const rating = fileInfo.ratings_array.find(r => r.service_key === serviceKey);
        // Only return true if we explicitly have a true value
        return rating?.value === true;
      }
      return false;
    } 
    catch (error) {
      this.errorService.handleHydrusError(error);
      return false;
    }
  }

  private async toggleLikeRating(
    file: HydrusBasicFile,
    likeService: { service_key: string },
    buttonElement: HTMLElement,
    cache: Map<string, boolean>,
  ) {
    try {
      const currentRating =
        cache.get(file.hash) ??
        await this.getCurrentRating(file, likeService.service_key);

      const newRating = currentRating ? null : true;

      await firstValueFrom(
        this.ratingsService.setRating(file.hash, likeService.service_key, newRating),
      );

      const liked = newRating === true;
      cache.set(file.hash, liked);
      this.setLikeIcon(buttonElement, liked);

      this.snackbar.open(
        newRating ? 'Added to favorites' : 'Removed from favorites',
        undefined,
        { duration: 1000 }
      );

    } catch (error) {
      this.errorService.handleHydrusError(error);
    }
  }

  private likeRequestId = 0;

  private setLikeIcon(buttonElement: HTMLElement, liked: boolean) {
    const icon = buttonElement.querySelector('.mat-icon');
    const next = liked ? 'favorite' : 'favorite_outline';
    if (icon && icon.textContent !== next) {
      icon.textContent = next;
    }
  }

  private async updateLikeButtonState(
    file: HydrusBasicFile,
    serviceKey: string,
    buttonElement: HTMLElement,
    cache: Map<string, boolean>,
  ) {
    const icon = buttonElement.querySelector('.mat-icon');
    if (!icon) return;

    const cached = cache.get(file.hash);
    if (cached !== undefined) {
      this.setLikeIcon(buttonElement, cached);
      return;
    }

    icon.textContent = 'sync';

    const requestId = ++this.likeRequestId;
    const isLiked = await this.getCurrentRating(file, serviceKey);

    // Ignore stale responses and elements removed by PhotoSwipe.
    if (requestId !== this.likeRequestId || !buttonElement.isConnected) {
      return;
    }

    cache.set(file.hash, isLiked);
    this.setLikeIcon(buttonElement, isLiked);
  }

  private createVideoElement(
    file: HydrusBasicFile,
    content: Content,
    isLazy: boolean,
  ): HTMLVideoElement {
    const settings = this.settingsService.appSettings;

    const video = document.createElement('video');
    video.className = 'pswp-video pswp-media';
    video.poster = file.thumbnail_url;
    video.controls = settings.mediaControls;
    video.loop = settings.mediaLoop;
    video.muted = settings.mediaDefaultMuted;
    video.playsInline = !settings.mediaAutoFullscreen;
    video.preload = isLazy ? 'none' : 'metadata';

    // Only the active/non-lazy slide gets a src. The activate handler adds it later.
    if (!isLazy) {
      video.src = file.file_url;
    }

    video.addEventListener('loadedmetadata', () => content.onLoaded(), { once: true });
    video.addEventListener('error', () => content.onError(), { once: true });

    return video;
  }



}
