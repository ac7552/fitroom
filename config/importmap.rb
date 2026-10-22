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
