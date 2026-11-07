import './ui/style.css';
import { Game } from './game/Game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const game = new Game(canvas, ui);
game.init().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (l) l.textContent = 'The lantern would not light: ' + (e instanceof Error ? e.message : String(e)) + ' (WebGL2 is required)';
});
