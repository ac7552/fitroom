// N8AO (vendor/javascript/n8ao.js) imports `Pass` from the "postprocessing" library for its N8AOPostPass,
// which Fitroom doesn't use (it uses N8AOPass with three.js's own EffectComposer). This stands in for that
// library so the import resolves without shipping it.
export class Pass {}
