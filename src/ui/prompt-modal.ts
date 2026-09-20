// Small reusable modals: a single-line text prompt and a yes/no confirmation. Used by
// several actions (link folder path, forget a catalog entry, etc.) so they don't each need
// their own Modal subclass.

import { App, Modal, Setting } from 'obsidian';

export function promptText(
  app: App,
  opts: { title: string; placeholder?: string; initial?: string; submitLabel?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (value: string | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    class PromptModal extends Modal {
      private value = opts.initial ?? '';

      onOpen(): void {
        this.setTitle(opts.title);
        const { contentEl } = this;

        new Setting(contentEl).addText((text) => {
          text.setPlaceholder(opts.placeholder ?? '').setValue(this.value);
          text.onChange((v) => {
            this.value = v;
          });
          text.inputEl.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') {
              evt.preventDefault();
              this.close();
              settle(this.value);
            } else if (evt.key === 'Escape') {
              evt.preventDefault();
              this.close();
              settle(null);
            }
          });
          window.setTimeout(() => text.inputEl.focus(), 0);
        });

        new Setting(contentEl).addButton((btn) =>
          btn
            .setButtonText(opts.submitLabel ?? 'Submit')
            .setCta()
            .onClick(() => {
              this.close();
              settle(this.value);
            }),
        );
      }

      onClose(): void {
        this.contentEl.empty();
        settle(null); // closed without an explicit submit (e.g. clicked outside)
      }
    }

    new PromptModal(app).open();
  });
}

export function confirm(app: App, opts: { title: string; message: string; okLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (value: boolean): void => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    class ConfirmModal extends Modal {
      onOpen(): void {
        this.setTitle(opts.title);
        const { contentEl } = this;
        contentEl.createEl('p', { text: opts.message });

        new Setting(contentEl)
          .addButton((btn) =>
            btn.setButtonText('Cancel').onClick(() => {
              this.close();
              settle(false);
            }),
          )
          .addButton((btn) =>
            btn
              .setButtonText(opts.okLabel ?? 'OK')
              .setCta()
              .onClick(() => {
                this.close();
                settle(true);
              }),
          );
      }

      onClose(): void {
        this.contentEl.empty();
        settle(false);
      }
    }

    new ConfirmModal(app).open();
  });
}
