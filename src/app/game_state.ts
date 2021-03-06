import {BrowserWindow} from 'electron';
import electronIsDev from 'electron-is-dev';
import psList from 'ps-list';

import {getMetadata, getUserMetadata} from 'root/api/overlay';
import {registerHotkeys, unRegisterHotkeys} from 'root/app/hotkeys';
import {WindowLocator} from 'root/app/locatewindow';
import {sendMessageToHomeWindow, sendMessageToOverlayWindow} from 'root/app/messages';
import {createOverlayWindow, getOverlayWindow} from 'root/app/overlay_window';
import {settingsStore} from 'root/app/settings-store/settings_store';
import {error} from 'root/lib/logger';
import {isMac} from 'root/lib/utils';
import {withLogParser} from './log_parser_manager';

class GameState {
  private readonly startTimeMillis: number;
  private running: boolean;
  private overlayInterval: NodeJS.Timeout | undefined;
  private psListInterval: NodeJS.Timeout | undefined;
  private processId: number | undefined;
  private refreshMillis = 500;
  private readonly processName = isMac() ? 'MTGA.app/Contents/MacOS/MTGA' : 'MTGA.exe';
  private readonly movementSensitivity = 1;
  private readonly overlayPositioner = new WindowLocator();
  private overlayIsPositioned = false;
  public isFullscreen: boolean = false;

  constructor() {
    this.startTimeMillis = Date.now();
    this.running = false;
    this.checkProcessId();
  }

  public setRefreshRate(refreshRate: number): void {
    this.refreshMillis = refreshRate;
    if (this.overlayInterval !== undefined) {
      clearInterval(this.overlayInterval);
      this.overlayInterval = undefined;
    }
    this.startOverlay();
  }

  public getStartTime(): number {
    return this.startTimeMillis;
  }

  public setRunning(running: boolean): void {
    //console.log('setRunning', running);
    if (!this.running && running) {
      this.running = true;
      this.startOverlay();
      this.psListInterval = setInterval(() => this.checkProcessId(), this.refreshMillis);
      withLogParser((logParser) => {
        logParser.changeParserFreq(undefined).catch((err) => {
          error('Failure to start log parser', err);
        });
      });
    } else if (this.running && !running) {
      this.running = running;
      this.stopOverlay();
      if (this.psListInterval) {
        clearInterval(this.psListInterval);
        this.psListInterval = undefined;
      }
      withLogParser((logParser) => {
        logParser.changeParserFreq(2000).catch((err) => {
          error('Failure to start log parser', err);
        });
      });
      sendMessageToHomeWindow('show-status', {message: 'Game is not running!', color: '#dbb63d'});
    }
  }

  public getProcessId(): number {
    return this.processId ?? -1;
  }

  private showOverlay(overlayWindow: BrowserWindow): void {
    /*if (electronIsDev) {
      console.log('Showing Overlay');
    }*/
    if (!overlayWindow.isVisible()) {
      registerHotkeys();
      if (isMac()) {
        overlayWindow.showInactive();
      } else {
        setTimeout(overlayWindow.show.bind(overlayWindow), 400);
      }
    }
  }

  private hideOverlay(overlayWindow: BrowserWindow): void {
    unRegisterHotkeys();
    overlayWindow.hide();
  }

  public overlayPositionSetter(onlySetPosition?: boolean): void {
    const account = settingsStore.getAccount();
    /*if (electronIsDev) {
      console.log('Doing positioning!');
    }*/
    if (account && settingsStore.get().overlay) {
      if (!onlySetPosition) {
        this.overlayPositioner.findMtga(account, !isMac());

        if (this.isFullscreen !== this.overlayPositioner.isFullscreen) {
          this.isFullscreen = this.overlayPositioner.isFullscreen;
          if (this.isFullscreen) {
            if (this.refreshMillis !== 2000) {
              this.setRefreshRate(2000);
            }
          } else {
            if (this.refreshMillis !== 500) {
              this.setRefreshRate(500);
            }
          }
        }
      }
      const ovlSettings = account.overlaySettings;
      let overlayWindow = getOverlayWindow();

      if (!overlayWindow) {
        overlayWindow = createOverlayWindow();
        getMetadata()
          .then((md) => {
            //console.log(md.allcards);
            sendMessageToOverlayWindow('set-metadata', md);
            sendMessageToOverlayWindow('set-ovlsettings', ovlSettings);
            sendMessageToOverlayWindow('set-icosettings', settingsStore.get().icon);
          })
          .catch((err) => {
            error('Failure to load Metadata', err);
          });
        getUserMetadata(+account.uid)
          .then((umd) => sendMessageToOverlayWindow('set-userdata', umd))
          .catch((err) => {
            error('Failure to load User Metadata', err, {...account});
          });
      }
      /*if (electronIsDev) {
        console.log('Got new bounds', this.overlayPositioner.bounds);
      }*/
      if (isMac()) {
        if (!overlayWindow.isFocused()) {
          overlayWindow.focus();
        }
      }
      if (
        this.overlayPositioner.bounds.width !== 0 &&
        (Math.abs(overlayWindow.getBounds().x - this.overlayPositioner.bounds.x) > this.movementSensitivity ||
          Math.abs(overlayWindow.getBounds().y - this.overlayPositioner.bounds.y) > this.movementSensitivity ||
          Math.abs(overlayWindow.getBounds().width - this.overlayPositioner.bounds.width) > this.movementSensitivity ||
          Math.abs(overlayWindow.getBounds().height - this.overlayPositioner.bounds.height) >
            this.movementSensitivity ||
          !this.overlayIsPositioned)
      ) {
        this.showOverlay(overlayWindow);
        const EtalonHeight = 1144;
        const zoomFactor = this.overlayPositioner.bounds.height / EtalonHeight;
        sendMessageToOverlayWindow('set-zoom', zoomFactor);
        try {
          overlayWindow.setBounds(this.overlayPositioner.bounds);
          this.overlayIsPositioned = true;
        } catch (err) {
          error("couldn't set overlay bounds, hiding overlay for now", err);
          this.hideOverlay(overlayWindow);
        }
      } else if (
        (this.overlayPositioner.bounds.width === 0 && (!ovlSettings || !ovlSettings.neverhide)) ||
        !this.overlayIsPositioned
      ) {
        if (isMac()) {
          if (!overlayWindow.isFocused()) {
            this.hideOverlay(overlayWindow);
          }
        } else {
          this.hideOverlay(overlayWindow);
        }
      } else {
        this.showOverlay(overlayWindow);
      }
    }
  }

  private startOverlay(): void {
    if (!isMac()) {
      //console.log('Starting Overlay new way!');
      this.overlayPositionSetter(false);
    } else if (this.overlayInterval === undefined) {
      this.overlayInterval = setInterval(
        (() => {
          this.overlayPositionSetter(false);
        }).bind(this),
        this.refreshMillis
      );
    }
  }

  private stopOverlay(): void {
    if (this.overlayInterval !== undefined) {
      clearInterval(this.overlayInterval);
      this.overlayInterval = undefined;
    }
    const overlayWindow = getOverlayWindow();
    if (overlayWindow) {
      overlayWindow.hide();
    }
  }

  public checkProcessId(): void {
    if (this.processId !== undefined) {
      try {
        process.kill(this.processId, 0);
      } catch {
        this.processId = undefined;
        this.setRunning(false);
      }
    } else {
      //console.log('pinging psList');
      psList()
        .then((processes) => {
          const res = processes.find((proc) =>
            isMac() ? proc.cmd?.includes(this.processName) : proc.name === this.processName
          );
          if (res !== undefined) {
            this.processId = res.pid;
            this.setRunning(true);
          }
        })
        .catch(() => {});
    }

    if (this.overlayPositioner.SpawnedProcess && !this.running) {
      this.overlayPositioner.killSpawnedProcess();
    }
  }
}

export const gameState = new GameState();
