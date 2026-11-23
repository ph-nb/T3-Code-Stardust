import {
  createStarshipParticles,
  drawStarshipScene,
  prewarmStarshipParticles,
  sampleStarshipAccent,
  stepStarshipParticles,
} from "@t3tools/shared/starshipScene";
import type { StarshipSliderConfiguration } from "./starship-slider-document";

const canvas = document.querySelector("canvas")!;
const context = canvas.getContext("2d")!;
const particles = createStarshipParticles(48);
prewarmStarshipParticles(particles, 0);
let configuration: StarshipSliderConfiguration | null = null;
let ratio = 0;
let target = 0;
let frame = 0;
let previous = 0;
let activity = 0;
let dragging = false;
let pendingIndex = 0;
let time = 2.4;

function paint(now: number) {
  frame = 0;
  const config = configuration;
  if (!config || !config.active || document.hidden) return;
  const delta = Math.min(0.05, (now - previous) / 1000 || 1 / 24);
  if (!config.reducedMotion && now - previous < 1000 / 24) {
    frame = requestAnimationFrame(paint);
    return;
  }
  previous = now;
  ratio = config.reducedMotion ? target : ratio + (target - ratio) * Math.min(1, delta * 14);
  const width = Math.max(1, canvas.clientWidth);
  const height = 56;
  const density = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * density) || canvas.height !== height * density) {
    canvas.width = Math.round(width * density);
    canvas.height = height * density;
  }
  context.setTransform(density, 0, 0, density, 0, 0);
  if (!config.reducedMotion) time += delta;
  const knob = 26 + (width - 52) * ratio;
  const ship = drawStarshipScene(context, width, height, ratio, knob, time, particles, 0);
  if (!config.reducedMotion)
    stepStarshipParticles(particles, delta, ratio, ship.nx, ship.ny, ship.angle, width);
  context.strokeStyle = sampleStarshipAccent(ratio);
  context.lineWidth = 2;
  context.fillStyle = "rgba(255,255,255,.12)";
  context.beginPath();
  context.roundRect(knob - 22, 5, 44, 46, 14);
  context.fill();
  context.stroke();
  if (
    !config.reducedMotion &&
    (dragging || Math.abs(target - ratio) > 0.001 || now - activity < 2000)
  ) {
    frame = requestAnimationFrame(paint);
  }
}

function wake() {
  activity = performance.now();
  if (!frame) frame = requestAnimationFrame(paint);
}

export function update(next: StarshipSliderConfiguration) {
  configuration = next;
  pendingIndex = Math.max(
    0,
    next.options.findIndex((option) => option.id === next.value),
  );
  target = next.options.length > 1 ? pendingIndex / (next.options.length - 1) : 0;
  if (!next.active && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  wake();
}

function move(event: PointerEvent) {
  const config = configuration;
  if (!config || config.disabled || config.options.length < 2) return;
  const bounds = canvas.getBoundingClientRect();
  const position = Math.max(
    0,
    Math.min(1, (event.clientX - bounds.left - 26) / Math.max(1, bounds.width - 52)),
  );
  pendingIndex = Math.round(position * (config.options.length - 1));
  target = pendingIndex / (config.options.length - 1);
  wake();
}

canvas.addEventListener("pointerdown", (event) => {
  if (!configuration || configuration.disabled) return;
  dragging = true;
  canvas.setPointerCapture(event.pointerId);
  move(event);
});
canvas.addEventListener("pointermove", (event) => {
  if (dragging) move(event);
});
canvas.addEventListener("pointerup", (event) => {
  if (!dragging) return;
  move(event);
  dragging = false;
  const option = configuration?.options[pendingIndex];
  if (option) window.ReactNativeWebView?.postMessage(JSON.stringify({ id: option.id }));
  wake();
});
canvas.addEventListener("pointercancel", () => {
  dragging = false;
  if (configuration) update(configuration);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  } else wake();
});
window.addEventListener("resize", wake);
