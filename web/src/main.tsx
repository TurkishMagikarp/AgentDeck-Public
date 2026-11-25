import { render } from 'solid-js/web'
import { App } from './App'
import { keepTicksReadable } from './charts'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import './mission.css'
import './polish.css'

render(() => <App />, document.getElementById('app')!)
keepTicksReadable()
