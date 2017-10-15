import { forEach, Registry, without } from '../util'

/*
  Keeps commandStates up-to-date, e.g. whenever the
  document or the selection is changed.

  The contract is that the CommandManager maintains a state for each
  command contributing to the global application state.
*/
export default class CommandManager {

  constructor(context, commands) {
    const editorSession = context.editorSession
    if (!editorSession) {
      throw new Error('EditorSession required.')
    }
    this.editorSession = context.editorSession
    // commands by name
    this.commands = commands

    // a context which is provided to the commands
    // for evaluation of state and for execution
    this.context = Object.assign({}, context, {
      // for convenienve we provide access to the doc directly
      doc: this.editorSession.getDocument()
    })

    // some initializations such as setting up a registry
    this._initialize()

    let state = this.editorSession.state
    state.reduce('commandStates', ['#commandState'], this._updateCommandStates, this)
  }

  dispose() {
    this.editorSession.state.disconnect(this)
  }

  /*
    Execute a command, given a context and arguments.

    Commands are run async if cmd.isAsync() returns true.
  */
  executeCommand(commandName, userParams, cb) {
    let cmd = this._getCommand(commandName)
    if (!cmd) {
      console.warn('command', commandName, 'not registered')
      return
    }
    let commandStates = this.editorSession.getCommandStates()
    let commandState = commandStates[commandName]
    let params = Object.assign(this._getCommandParams(), userParams, {
      commandState: commandState
    })

    if (cmd.isAsync) {
      // TODO: Request UI lock here
      this.editorSession.lock()
      cmd.execute(params, this._getCommandContext(), (err, info) => {
        if (err) {
          if (cb) {
            cb(err)
          } else {
            console.error(err)
          }
        } else {
          if (cb) cb(null, info)
        }
        this.editorSession.unlock()
      })
    } else {
      let info = cmd.execute(params, this._getCommandContext())
      return info
    }
  }

  _initialize() {
    this.commandRegistry = new Registry()
    forEach(this.commands, (command) => {
      this.commandRegistry.add(command.name, command)
    })
  }

  _getCommand(commandName) {
    return this.commandRegistry.get(commandName)
  }

  /*
    Compute new command states object
  */
  _updateCommandStates(state) {
    const commandContext = this._getCommandContext()
    const params = this._getCommandParams()
    const surface = params.surface
    const commandRegistry = this.commandRegistry

    // TODO: discuss, and maybe think about optimizing this
    // by caching the result...
    let commandStates = {}
    let commandNames = commandRegistry.names.slice()
    // first assume that all of the commands are disabled
    commandNames.forEach((name) => {
      commandStates[name] = { disabled: true }
    })
    // EXPERIMENTAL: white-list and black-list support via Surface props
    if (surface) {
      let included = surface.props.commands
      let excluded = surface.props.excludedCommands
      if (included) {
        commandNames = included.filter((name) => {
          return commandRegistry.contains(name)
        })
      } else if (excluded) {
        commandNames = without(commandNames, ...excluded)
      }
    }
    const commands = commandNames.map(name => commandRegistry.get(name))
    commands.forEach((cmd) => {
      if (cmd) {
        commandStates[cmd.getName()] = cmd.getCommandState(params, commandContext)
      }
    })

    state.set('commandStates', commandStates)
  }

  _getCommandContext() {
    return this.context
  }

  _getCommandParams() {
    const state = this.context.state
    let editorSession = this.context.editorSession
    let sel = state.get('selection')
    let surface = this.context.surfaceManager.getFocusedSurface()
    return {
      editorSession: editorSession,
      surface: surface,
      selection: sel,
      // LEGACY:
      selectionState: editorSession._selectionState
    }
  }
}
