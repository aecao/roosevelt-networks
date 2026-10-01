import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ShaderGradient, ShaderGradientCanvas } from '@shadergradient/react';

export function mountNetworkGradient(container) {
  const root = createRoot(container);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let shaderTime = 0;

  function render() {
    root.render(createElement(
      ShaderGradientCanvas,
      {
        style: { position: 'absolute', inset: 0 },
        pixelDensity: 1,
        fov: 45,
        pointerEvents: 'none',
        powerPreference: 'low-power',
      },
      createElement(ShaderGradient, {
        animate: 'off',
        type: 'plane',
        shader: 'defaults',
        color1: '#063325',
        color2: '#101e30',
        color3: '#332b13',
        brightness: 1.1,
        grain: 'off',
        uTime: shaderTime,
        uSpeed: 0.4,
        uStrength: 1.25,
        uDensity: 1.3,
        uFrequency: 3.5,
        uAmplitude: 1,
      }),
    ));
  }

  render();

  return (displacement) => {
    if (reducedMotion || !Number.isFinite(displacement) || displacement <= 0) return;
    shaderTime = (shaderTime + Math.min(displacement * 0.08, 0.08)) % 100;
    render();
  };
}