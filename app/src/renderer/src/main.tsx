import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { getApi } from './api'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root element not found')

createRoot(root).render(
  <React.StrictMode>
    <App api={getApi()} />
  </React.StrictMode>
)
