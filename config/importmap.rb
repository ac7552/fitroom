# Pin npm packages by running ./bin/importmap

pin "application"
pin "@hotwired/turbo-rails", to: "turbo.min.js"
pin "@hotwired/stimulus", to: "stimulus.min.js"
pin "@hotwired/stimulus-loading", to: "stimulus-loading.js"
pin_all_from "app/javascript/controllers", under: "controllers"
pin_all_from "app/javascript/lib", under: "lib"
pin "three", to: "three.js"
pin "three/addons/environments/RoomEnvironment.js", to: "three-addons/RoomEnvironment.js"
pin "three/addons/controls/OrbitControls.js", to: "three-addons/OrbitControls.js"
pin "three/addons/loaders/GLTFLoader.js", to: "three-addons/GLTFLoader.js"
pin "three/addons/utils/BufferGeometryUtils.js", to: "three-addons/BufferGeometryUtils.js"
pin "three/addons/loaders/RGBELoader.js", to: "three-addons/RGBELoader.js"
# Contact shading (N8AO, CC0) through three.js's own effect pipeline, with SMAA for edges; all r170 like three.js.
pin "n8ao", to: "n8ao.js"
pin "postprocessing", to: "postprocessing-shim.js"
pin "three/examples/jsm/postprocessing/Pass.js", to: "three-addons/Pass.js"
%w[EffectComposer OutputPass SMAAPass ShaderPass MaskPass Pass].each do |name|
  pin "three/addons/postprocessing/#{name}.js", to: "three-addons/#{name}.js"
end
%w[CopyShader OutputShader SMAAShader].each do |name|
  pin "three/addons/shaders/#{name}.js", to: "three-addons/#{name}.js"
end
