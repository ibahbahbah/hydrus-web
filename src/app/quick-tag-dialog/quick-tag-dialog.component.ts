import { Component, Inject } from '@angular/core';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { ErrorService } from '../error.service';
import { HydrusBasicFile } from '../hydrus-file';
import { HydrusTagsService } from '../hydrus-tags.service';

export interface QuickTagDialogData {
  file: HydrusBasicFile;
  tags: string[];
  serviceKey: string;
  existingTags: string[];
}

@Component({
  selector: 'app-quick-tag-dialog',
  templateUrl: './quick-tag-dialog.component.html',
  styleUrls: ['./quick-tag-dialog.component.scss'],
})
export class QuickTagDialogComponent {

  readonly file: HydrusBasicFile;
  readonly tags: string[];
  readonly serviceKey: string;

  readonly busy = new Set<string>();
  readonly added: Set<string>;

  constructor(
    @Inject(MAT_DIALOG_DATA) data: QuickTagDialogData,
    private dialogRef: MatDialogRef<QuickTagDialogComponent>,
    private tagsService: HydrusTagsService,
    private snackbar: MatSnackBar,
    private errorService: ErrorService,
  ) {
    this.file = data.file;
    this.tags = data.tags;
    this.serviceKey = data.serviceKey;

    const existing = new Set(data.existingTags.map(tag => this.normalizeTag(tag)));
    this.added = new Set(data.tags.filter(tag => existing.has(this.normalizeTag(tag))));
  }

  static open(dialog: MatDialog, file: HydrusBasicFile, tags: string[], serviceKey: string, existingTags: string[]) {
    return dialog.open<QuickTagDialogComponent, QuickTagDialogData>(QuickTagDialogComponent, {
      data: { file, tags, serviceKey, existingTags },
      width: '360px',
      maxWidth: '90vw',
      height: '70vh',
      maxHeight: '520px',
      closeOnNavigation: true,
      panelClass: 'quick-tag-dialog',
    });
  }

  private normalizeTag(tag: string) {
    return tag.trim().toLowerCase();
  }

  isBusy(tag: string) {
    return this.busy.has(tag);
  }

  wasAdded(tag: string) {
    return this.added.has(tag);
  }

  async toggleTag(tag: string) {
    if (this.busy.has(tag)) {
      return;
    }

    this.busy.add(tag);

    try {
      if (this.added.has(tag)) {
        await firstValueFrom(this.tagsService.deleteTagsFromLocalService(this.file.hash, [tag], this.serviceKey));
        this.added.delete(tag);
        this.snackbar.open(
          `Removed tag: '${tag}'`,
          undefined,
          { duration: 2000 }
        );
      } else {
        await firstValueFrom(this.tagsService.addTagsToService(this.file.hash, [tag], this.serviceKey));
        this.added.add(tag);

        const snackbarRef = this.snackbar.open(
          `Added tag: '${tag}'`,
          'Undo',
          { duration: 2000 }
        );

        snackbarRef.onAction().subscribe(async () => {
          try {
            await firstValueFrom(this.tagsService.deleteTagsFromLocalService(this.file.hash, [tag], this.serviceKey));
            this.added.delete(tag);
            this.snackbar.open(
              `Removed tag: '${tag}'`,
              undefined,
              { duration: 2000 }
            );
          } catch (error) {
            this.errorService.handleHydrusError(error);
          }
        });
      }
    } catch (error) {
      this.errorService.handleHydrusError(error);
    } finally {
      this.busy.delete(tag);
    }
  }

  close() {
    this.dialogRef.close();
  }

}
