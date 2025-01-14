import { Injectable } from '@angular/core';
import { RouteReuseStrategy, ActivatedRouteSnapshot, DetachedRouteHandle } from '@angular/router';

import { NativeScriptDebug } from '../../trace';
import { NSLocationStrategy } from './ns-location-strategy';
import { destroyComponentRef, findTopActivatedRouteNodeForOutlet, pageRouterActivatedSymbol } from './page-router-outlet-utils';

interface CacheItem {
  key: string;
  state: DetachedRouteHandle;
  isModal: boolean;
}

const getSnapshotKey = function (snapshot: ActivatedRouteSnapshot): string {
  return snapshot.pathFromRoot.join('->');
};

/**
 * Detached state cache
 */
class DetachedStateCache {
  private cache = new Array<CacheItem>();

  public get length(): number {
    return this.cache.length;
  }

  public push(cacheItem: CacheItem) {
    this.cache.push(cacheItem);
  }

  public pop(): CacheItem {
    return this.cache.pop();
  }

  public peek(): CacheItem {
    return this.cache[this.cache.length - 1];
  }

  public clear() {
    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routeReuseStrategyLog(`DetachedStateCache.clear() ${this.cache.length} items will be destroyed`);
    }

    while (this.cache.length > 0) {
      const state = <any>this.cache.pop().state;
      if (!state.componentRef) {
        throw new Error('No componentRef found in DetachedRouteHandle');
      }

      destroyComponentRef(state.componentRef);
    }
  }

  public clearModalCache() {
    let removedItemsCount = 0;
    const hasModalPages = this.cache.some((cacheItem) => {
      return cacheItem.isModal;
    });

    if (hasModalPages) {
      let modalCacheCleared = false;

      while (!modalCacheCleared) {
        let cacheItem = this.peek();
        const state = <any>cacheItem.state;

        if (!state.componentRef) {
          throw new Error('No componentRef found in DetachedRouteHandle');
        }

        destroyComponentRef(state.componentRef);
        if (cacheItem.isModal) {
          modalCacheCleared = true;
        }

        this.pop();
        removedItemsCount++;
      }
    }

    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routeReuseStrategyLog(`DetachedStateCache.clearModalCache() ${removedItemsCount} items will be destroyed`);
    }
  }
}

/**
 * Detaches subtrees loaded inside PageRouterOutlet in forward navigation
 * and reattaches them on back.
 * Reuses routes as long as their route config is the same.
 */
@Injectable()
export class NSRouteReuseStrategy implements RouteReuseStrategy {
  private cacheByOutlet: { [key: string]: DetachedStateCache } = {};

  constructor(private location: NSLocationStrategy) {}

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    route = findTopActivatedRouteNodeForOutlet(route);

    const { outlet } = this.findValidOutletAndKey(route);
    const key = getSnapshotKey(route);

    let isPageActivated = false;
    let tmp = route;
    while (!(isPageActivated = tmp[pageRouterActivatedSymbol]) && tmp.parent) {
      tmp = tmp.parent;
    }
    const isBack = outlet ? outlet.isPageNavigationBack : false;
    let shouldDetach = outlet && !isBack && isPageActivated;

    if (outlet) {
      if (outlet.parent && !outlet.parent.shouldDetach) {
        shouldDetach = false;
      }

      outlet.shouldDetach = shouldDetach;
    }

    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routeReuseStrategyLog(`shouldDetach isBack: ${isBack} key: ${key} result: ${shouldDetach}`);
    }

    return shouldDetach;
  }
  protected findValidOutletAndKey(targetRoute: ActivatedRouteSnapshot) {
    let route = targetRoute;
    const routeOutletKey = this.location.getRouteFullPath(route);
    let outletKey = routeOutletKey;
    let outlet = this.location.findOutlet(outletKey, route);
    while (!outlet) {
      if (!route.parent) {
        return { outlet: null, outletKey: routeOutletKey };
      }
      route = route.parent;
      outletKey = this.location.getRouteFullPath(route);
      outlet = this.location.findOutlet(outletKey, route);
    }

    if (outlet) {
      while (!outlet.outletKeys.includes(outletKey)) {
        if (!route.parent) {
          NativeScriptDebug.routeReuseStrategyLog(`Could not find valid outlet key for route: ${targetRoute}.`);
          return { outlet, outletKey: routeOutletKey };
        }
        route = route.parent;
        outletKey = this.location.getRouteFullPath(route);
      }
    }

    return { outlet, outletKey };
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    route = findTopActivatedRouteNodeForOutlet(route);

    const { outlet, outletKey } = this.findValidOutletAndKey(route);
    const cache = this.cacheByOutlet[outletKey];
    if (!cache) {
      return false;
    }

    const key = getSnapshotKey(route);
    const isBack = outlet ? outlet.isPageNavigationBack : false;
    const shouldAttach = isBack && cache.peek()?.key === key;

    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routeReuseStrategyLog(`shouldAttach isBack: ${isBack} key: ${key} result: ${shouldAttach}`);
    }

    if (outlet) {
      outlet.shouldDetach = true;
    }

    return shouldAttach;
  }

  store(route: ActivatedRouteSnapshot, state: DetachedRouteHandle): void {
    route = findTopActivatedRouteNodeForOutlet(route);

    const key = getSnapshotKey(route);
    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routeReuseStrategyLog(`store key: ${key}, state: ${state}`);
    }

    const { outletKey } = this.findValidOutletAndKey(route);

    // tslint:disable-next-line:max-line-length
    const cache = (this.cacheByOutlet[outletKey] = this.cacheByOutlet[outletKey] || new DetachedStateCache());

    if (state) {
      let isModal = false;
      if (this.location._modalNavigationDepth > 0) {
        isModal = true;
      }

      cache.push({ key, state, isModal });
    } else {
      const topItem = cache.peek();
      if (topItem.key === key) {
        cache.pop();

        if (!cache.length) {
          delete this.cacheByOutlet[outletKey];
        }
      } else {
        throw new Error("Trying to pop from DetachedStateCache but keys don't match. " + `expected: ${topItem.key} actual: ${key}`);
      }
    }
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    route = findTopActivatedRouteNodeForOutlet(route);

    const { outlet, outletKey } = this.findValidOutletAndKey(route);
    const cache = this.cacheByOutlet[outletKey];
    if (!cache) {
      return null;
    }

    const key = getSnapshotKey(route);
    const isBack = outlet ? outlet.isPageNavigationBack : false;
    const cachedItem = cache.peek();

    let state = null;
    if (isBack && cachedItem && cachedItem.key === key) {
      state = cachedItem.state;
    }

    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routeReuseStrategyLog(`retrieved isBack: ${isBack} key: ${key} state: ${state}`);
    }

    return state;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    const shouldReuse = future.routeConfig === curr.routeConfig;

    if (shouldReuse && curr && curr[pageRouterActivatedSymbol]) {
      // When reusing route - copy the pageRouterActivated to the new snapshot
      // It's needed in shouldDetach to determine if the route should be detached.
      future[pageRouterActivatedSymbol] = curr[pageRouterActivatedSymbol];
    }

    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routeReuseStrategyLog(`shouldReuseRoute result: ${shouldReuse}`);
    }

    return shouldReuse;
  }

  clearCache(outletKey: string) {
    const cache = this.cacheByOutlet[outletKey];

    if (cache) {
      cache.clear();
    }
  }

  popCache(outletKey: string) {
    const cache = this.cacheByOutlet[outletKey];

    if (cache) {
      if (cache.peek()) {
        const state: any = cache.pop()?.state;
        if (state?.componentRef) {
          destroyComponentRef(state?.componentRef);
        }
      }
    }
  }

  clearModalCache(outletKey: string) {
    const cache = this.cacheByOutlet[outletKey];

    if (cache) {
      cache.clearModalCache();
    }
  }
}
