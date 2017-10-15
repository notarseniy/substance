import forEach from './forEach'

/*
  A graph allowing to define dependencies
  between symbols.

  For example, for an Expression engine a topologically correct
  evaluation order can be derived by ordering the expressions
  by the rank of their input dependencies.

  The `rank` of a variable denotes the number of reduction steps
  necessary to retrieve the value of a variable.
*/
export default class DependencyGraph {

  constructor() {
    // name -> inputs
    this._deps = {}
    // name -> rank
    this._ranks = null
  }

  addDependency(name, deps) {
    this._addDependency(name, deps)
    this._update()
  }

  getRank(name) {
    const ranks = this._getRanks()
    return ranks[name]
  }

  getMinimumRank(names) {
    const ranks = this._getRanks()
    const res = names.map((name) => {
      let rank = ranks[name]
      if (rank === undefined) {
        rank = Number.MAX_VALUE
      }
      return rank
    })
    return Math.min(...res)
  }

  getMaximumRank(names) {
    const ranks = this._getRanks()
    const res = names.map((name) => {
      let rank = ranks[name]
      if (rank === undefined) {
        rank = -1
      }
      return rank
    })
    return Math.max(...res)
  }

  _getRanks() {
    if (!this._ranks) {
      this._update()
    }
    return this._ranks
  }

  _addDependency(name, deps) {
    this._invalidate()
    if (!this._deps[name]) {
      this._deps[name] = new Set()
    }
    deps.forEach((dep) => {
      // TODO: rethink. Sources, such as 'document' or 'selection' are not
      // 'reduced', so they are not registered in the dependency registry
      // Should we introduce them explicitly?
      if (!this._deps[dep]) {
        this._deps[dep] = new Set()
      }
      this._deps[name].add(dep)
    })
  }

  _invalidate() {
    this._ranks = null
  }

  _update() {
    const ranks = {}
    forEach(this._deps, (deps, name) => {
      this._computeRank(name, deps, ranks)
    })
    this._ranks = ranks
  }

  _computeRank(name, deps, ranks) {
    let rank
    // dependencies might have been computed already
    // when this entry has been visited through the dependencies
    // of another entry
    // Initially, we set level=-1, so when we visit
    // an entry with level===-1, we know that there
    // must be a cyclic dependency.
    if (ranks.hasOwnProperty(name)) {
      rank = ranks[name]
      if (rank === -1) {
        throw new Error('Found a cyclic dependency.')
      }
      return rank
    }
    // using value -1 as guard to detect cyclic deps
    ranks[name] = -1
    // a resource without dependencies has rank = 0
    rank = 0
    if (deps.size > 0) {
      let depRanks = []
      deps.forEach((_name) => {
        let _deps = this._deps[_name] || []
        depRanks.push(this._computeRank(_name, _deps, ranks))
      })
      rank = Math.max(...depRanks) + 1
    }
    ranks[name] = rank
    return rank
  }
}