import { render } from 'solid-js/web'
import { App } from './App'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'

render(() => <App />, document.getElementById('app')!)
