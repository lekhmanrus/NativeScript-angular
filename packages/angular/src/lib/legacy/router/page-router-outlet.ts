import { Attribute, ChangeDetectorRef, ComponentFactory, ComponentFactoryResolver, ComponentRef, Directive, Inject, InjectionToken, Injector, OnDestroy, EventEmitter, Output, Type, ViewContainerRef, ElementRef, InjectFlags, NgZone, EnvironmentInjector } from '@angular/core';
import { ActivatedRoute, ActivatedRouteSnapshot, ChildrenOutletContexts, Data, PRIMARY_OUTLET, RouterOutletContract } from '@angular/router';

import { Frame, Page, NavigatedData, profile, NavigationEntry } from '@nativescript/core';

import { BehaviorSubject } from 'rxjs';

import { PAGE_FACTORY, PageFactory } from '../../tokens';
import { NativeScriptDebug } from '../../trace';
import { DetachedLoader } from '../../cdk/detached-loader';
import { ViewUtil } from '../../view-util';
import { NSLocationStrategy } from './ns-location-strategy';
import { Outlet } from './ns-location-utils';
import { NSRouteReuseStrategy } from './ns-route-reuse-strategy';
import { findTopActivatedRouteNodeForOutlet, pageRouterActivatedSymbol, loaderRefSymbol, destroyComponentRef } from './page-router-outlet-utils';
import { registerElement } from '../../element-registry';
import { PageService } from '../../cdk/frame-page/page.service';

export class PageRoute {
  activatedRoute: BehaviorSubject<ActivatedRoute>;

  constructor(startRoute: ActivatedRoute) {
    this.activatedRoute = new BehaviorSubject(startRoute);
  }
}

export class DestructibleInjector implements Injector {
  private refs = new Set<any>();
  constructor(private destructableProviders: ProviderSet, private parent: Injector) {}
  get<T>(token: Type<T> | InjectionToken<T>, notFoundValue?: T, flags?: InjectFlags): T {
    const ref = this.parent.get(token, notFoundValue, flags);
    if (this.destructableProviders.has(token)) {
      this.refs.add(ref);
    }
    return ref;
  }
  destroy() {
    this.refs.forEach((ref) => {
      if (ref.ngOnDestroy instanceof Function) {
        ref.ngOnDestroy();
      }
    });
    this.refs.clear();
  }
}

type ProviderSet = Set<Type<any> | InjectionToken<any>>;

const routeToString = function (activatedRoute: ActivatedRoute | ActivatedRouteSnapshot): string {
  return activatedRoute.pathFromRoot.join('->');
};

registerElement('page-router-outlet', () => Frame);
// eslint-disable-next-line @angular-eslint/directive-selector
@Directive({ selector: 'page-router-outlet' }) // tslint:disable-line:directive-selector
// eslint-disable-next-line @angular-eslint/directive-class-suffix
export class PageRouterOutlet implements OnDestroy, RouterOutletContract {
  // tslint:disable-line:directive-class-suffix
  private activated: ComponentRef<any> | null = null;
  private _activatedRoute: ActivatedRoute | null = null;
  private detachedLoaderFactory: ComponentFactory<DetachedLoader>;

  private outlet: Outlet;
  private name: string;
  private isEmptyOutlet: boolean;
  private viewUtil: ViewUtil;
  private frame: Frame;

  attachEvents: EventEmitter<unknown> = new EventEmitter();
  detachEvents: EventEmitter<unknown> = new EventEmitter();

  // eslint-disable-next-line @angular-eslint/no-output-rename
  @Output('activate') activateEvents = new EventEmitter<any>(); // tslint:disable-line:no-output-rename
  // eslint-disable-next-line @angular-eslint/no-output-rename
  @Output('deactivate') deactivateEvents = new EventEmitter<any>(); // tslint:disable-line:no-output-rename

  /** @deprecated from Angular since v4 */
  get locationInjector(): Injector {
    return this.location.injector;
  }
  /** @deprecated from Angular since v4 */
  get locationFactoryResolver(): ComponentFactoryResolver {
    return this.resolver;
  }

  get isActivated(): boolean {
    return !!this.activated;
  }

  get component(): unknown {
    if (!this.activated) {
      if (NativeScriptDebug.isLogEnabled()) {
        NativeScriptDebug.routerLog('Outlet is not activated');
      }
      return;
    }

    return this.activated.instance;
  }
  get activatedRoute(): ActivatedRoute {
    if (!this.activated) {
      if (NativeScriptDebug.isLogEnabled()) {
        NativeScriptDebug.routerLog('Outlet is not activated');
      }
      return;
    }

    return this._activatedRoute;
  }

  get activatedRouteData(): Data {
    if (this._activatedRoute) {
      return this._activatedRoute.snapshot.data;
    }
    return {};
  }

  constructor(
    private parentContexts: ChildrenOutletContexts,
    private location: ViewContainerRef,
    @Attribute('name') name: string,
    @Attribute('actionBarVisibility') actionBarVisibility: string,
    @Attribute('isEmptyOutlet') isEmptyOutlet: boolean,
    private locationStrategy: NSLocationStrategy,
    private componentFactoryResolver: ComponentFactoryResolver,
    private resolver: ComponentFactoryResolver,
    private changeDetector: ChangeDetectorRef,
    @Inject(PAGE_FACTORY) private pageFactory: PageFactory,
    private routeReuseStrategy: NSRouteReuseStrategy,
    private ngZone: NgZone,
    elRef: ElementRef,
    viewUtil: ViewUtil
  ) {
    this.isEmptyOutlet = isEmptyOutlet;
    this.frame = elRef.nativeElement;
    this.setActionBarVisibility(actionBarVisibility);
    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routerLog(`PageRouterOutlet.constructor frame: ${this.frame}`);
    }

    this.name = name || PRIMARY_OUTLET;
    parentContexts.onChildOutletCreated(this.name, <any>this);

    this.viewUtil = viewUtil;
    this.detachedLoaderFactory = resolver.resolveComponentFactory(DetachedLoader);
  }

  setActionBarVisibility(actionBarVisibility: string): void {
    switch (actionBarVisibility) {
      case 'always':
      case 'never':
        this.frame.actionBarVisibility = actionBarVisibility;
        return;

      default:
        this.frame.actionBarVisibility = 'auto';
    }
  }

  ngOnDestroy(): void {
    // In the event that the `parentContexts` has changed the outlet
    // via the creation of another outlet, the `onChildOutletDestroyed`
    // will be skipped
    if (this.parentContexts.getContext(this.name)?.outlet === <any>this) {
      // Clear accumulated modal view page cache when page-router-outlet
      // destroyed on modal view closing
      this.parentContexts.onChildOutletDestroyed(this.name);
    }

    if (this.outlet) {
      this.outlet.outletKeys.forEach((key) => {
        this.routeReuseStrategy.clearModalCache(key);
      });
      this.locationStrategy.clearOutlet(this.frame);
    } else {
      NativeScriptDebug.routerLog('PageRouterOutlet.ngOnDestroy: no outlet available for page-router-outlet');
    }

    if (this.isActivated) {
      const c = this.activated.instance;
      this.activated.hostView.detach();
      destroyComponentRef(this.activated);

      this.deactivateEvents.emit(c);
      this.activated = null;
    }
  }

  deactivate(): void {
    if (!this.outlet || !this.outlet.isPageNavigationBack) {
      if (NativeScriptDebug.isLogEnabled()) {
        NativeScriptDebug.routerLog('Currently not in page back navigation - component should be detached instead of deactivated.');
      }
      return;
    }

    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routerLog('PageRouterOutlet.deactivate() while going back - should destroy');
    }

    if (!this.isActivated) {
      return;
    }

    const c = this.activated.instance;
    destroyComponentRef(this.activated);

    this.activated = null;
    this._activatedRoute = null;

    this.deactivateEvents.emit(c);
  }

  /**
   * Called when the `RouteReuseStrategy` instructs to detach the subtree
   */
  detach(): ComponentRef<any> {
    if (!this.isActivated) {
      if (NativeScriptDebug.isLogEnabled()) {
        NativeScriptDebug.routerLog('Outlet is not activated');
      }
      return;
    }

    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routerLog(`PageRouterOutlet.detach() - ${routeToString(this._activatedRoute)}`);
    }

    // Detach from ChangeDetection
    this.activated.hostView.detach();

    const component = this.activated;
    this.activated = null;
    this._activatedRoute = null;
    this.detachEvents.emit(component.instance);
    return component;
  }

  /**
   * Called when the `RouteReuseStrategy` instructs to re-attach a previously detached subtree
   */
  attach(ref: ComponentRef<any>, activatedRoute: ActivatedRoute) {
    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routerLog(`PageRouterOutlet.attach() - ${routeToString(activatedRoute)}`);
    }

    this.activated = ref;

    // reattach to ChangeDetection
    this.activated.hostView.markForCheck();
    this.activated.hostView.reattach();
    this._activatedRoute = activatedRoute;
    this.markActivatedRoute(activatedRoute);

    // we have a child with the same name, so we don't finish the back nav
    if (this.isFinalPageRouterOutlet()) {
      this.locationStrategy._finishBackPageNavigation(this.frame);
    }
    this.attachEvents.emit(ref.instance);
  }

  private isFinalPageRouterOutlet() {
    let children = this.parentContexts.getContext(this.name)?.children;
    while (children) {
      const childContext = children.getContext(this.name);
      if (!childContext || !childContext.outlet) {
        return true;
      }
      if (childContext.outlet instanceof PageRouterOutlet) {
        return false;
      }
      children = childContext.children;
    }
    return true;
  }

  /**
   * Called by the Router to instantiate a new component during the commit phase of a navigation.
   * This method in turn is responsible for calling the `routerOnActivate` hook of its child.
   */
  @profile
  activateWith(activatedRoute: ActivatedRoute, resolver: ComponentFactoryResolver | EnvironmentInjector | null): void {
    this.outlet = this.outlet || this.getOutlet(activatedRoute.snapshot);
    if (!this.outlet) {
      if (NativeScriptDebug.isLogEnabled()) {
        NativeScriptDebug.routerError('No outlet found relative to activated route');
      }
      return;
    }

    this.outlet.isNSEmptyOutlet = this.isEmptyOutlet;
    this.locationStrategy.updateOutletFrame(this.outlet, this.frame, this.isEmptyOutlet);

    if (this.outlet && this.outlet.isPageNavigationBack) {
      if (NativeScriptDebug.isLogEnabled()) {
        NativeScriptDebug.routerLog('Currently in page back navigation - component should be reattached instead of activated.');
      }
      if (this.isFinalPageRouterOutlet()) {
        this.locationStrategy._finishBackPageNavigation(this.frame);
      }
    }

    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routerLog(`PageRouterOutlet.activateWith() - ${routeToString(activatedRoute)}`);
    }

    this._activatedRoute = activatedRoute;

    this.markActivatedRoute(activatedRoute);

    resolver = resolver || this.resolver;

    this.activateOnGoForward(activatedRoute, resolver);
    this.activateEvents.emit(this.activated.instance);
  }

  private activateOnGoForward(activatedRoute: ActivatedRoute, loadedResolver: ComponentFactoryResolver | EnvironmentInjector): void {
    if (NativeScriptDebug.isLogEnabled()) {
      NativeScriptDebug.routerLog('PageRouterOutlet.activate() forward navigation - ' + 'create detached loader in the loader container');
    }

    let resolver: ComponentFactoryResolver;
    let ourInjector = this.location.injector;
    if (!(loadedResolver instanceof ComponentFactoryResolver)) {
      ourInjector = loadedResolver;
      resolver = loadedResolver?.get(ComponentFactoryResolver);
    } else {
      resolver = loadedResolver;
    }

    const factory = this.getComponentFactory(activatedRoute, resolver);
    const page = this.pageFactory({
      isNavigation: true,
      componentType: factory.componentType,
    });

    const destructables = new Set([]);
    const injector = Injector.create({
      providers: [
        { provide: Page, useValue: page },
        { provide: Frame, useValue: this.frame },
        { provide: PageRoute, useValue: new PageRoute(activatedRoute) },
        { provide: ActivatedRoute, useValue: activatedRoute },
        { provide: ChildrenOutletContexts, useValue: this.parentContexts.getOrCreateContext(this.name).children },
        { provide: PageService, useClass: PageService },
      ],
      parent: ourInjector,
    });

    const childInjector = new DestructibleInjector(destructables, injector);
    const loaderRef = this.location.createComponent(this.detachedLoaderFactory, this.location.length, childInjector, []);
    loaderRef.onDestroy(() => childInjector.destroy());
    this.changeDetector.markForCheck();

    this.activated = loaderRef.instance.loadWithFactoryInLocation(factory);
    this.activated.changeDetectorRef.detectChanges();
    this.loadComponentInPage(page, this.activated, { activatedRoute });

    this.activated[loaderRefSymbol] = loaderRef;
  }

  @profile
  private loadComponentInPage(page: Page, componentRef: ComponentRef<any>, navigationContext): void {
    // Component loaded. Find its root native view.
    const componentView = componentRef.location.nativeElement;
    // Remove it from original native parent.
    this.viewUtil.removeChild(componentView.parent, componentView);
    // Add it to the new page
    this.viewUtil.appendChild(page, componentView);

    let topActivatedRoute = findTopActivatedRouteNodeForOutlet(this._activatedRoute.snapshot);
    let outletKey = this.locationStrategy.getRouteFullPath(topActivatedRoute);
    const thisRouteKey = outletKey;
    while (!this.locationStrategy.findOutlet(outletKey)) {
      topActivatedRoute = topActivatedRoute.parent;
      if (!topActivatedRoute) {
        NativeScriptDebug.routerError('Could not find outlet for route: ' + thisRouteKey);
        break;
      }
      outletKey = this.locationStrategy.getRouteFullPath(topActivatedRoute);
    }

    const navigatedFromCallback = (<any>global).Zone.current.wrap((args: NavigatedData) => {
      if (args.isBackNavigation) {
        this.locationStrategy._beginBackPageNavigation(this.frame, outletKey);
        this.locationStrategy.back(null, this.frame);
      }
    });
    // TODO: experiment with using NgZone instead of global above
    // const navigatedFromCallback = (args: NavigatedData) => {
    // 	if (args.isBackNavigation) {
    //     this.ngZone.run(() => {
    //       this.locationStrategy._beginBackPageNavigation(this.frame);
    //       this.locationStrategy.back(null, this.frame);
    //     });
    // 	}
    // };

    page.on(Page.navigatedFromEvent, navigatedFromCallback);
    componentRef.onDestroy(() => {
      if (page) {
        page.off(Page.navigatedFromEvent, navigatedFromCallback);
        page = null;
      }
    });

    const navOptions = this.locationStrategy._beginPageNavigation(this.frame);
    const isReplace = navOptions.replaceUrl && !navOptions.clearHistory;

    // Clear refCache if navigation with clearHistory
    if (navOptions.clearHistory) {
      const clearCallback = () =>
        setTimeout(() => {
          if (this.outlet) {
            // potential alternative fix (only fix children of the current outlet)
            // const nests = outletKey.split('/');
            // this.outlet.outletKeys.filter((k) => k.split('/').length >= nests.length).forEach((key) => this.routeReuseStrategy.clearCache(key));
            this.outlet.outletKeys.forEach((key) => this.routeReuseStrategy.clearCache(key));
          }
        });

      page.once(Page.navigatedToEvent, clearCallback);
    } else if (navOptions.replaceUrl) {
      const clearCallback = () =>
        setTimeout(() => {
          if (this.outlet) {
            // potential alternative fix (only fix children of the current outlet)
            // const nests = outletKey.split('/');
            // this.outlet.outletKeys.filter((k) => k.split('/').length >= nests.length).forEach((key) => this.routeReuseStrategy.popCache(key));
            this.outlet.outletKeys.forEach((key) => this.routeReuseStrategy.popCache(key));
          }
        });

      page.once(Page.navigatedToEvent, clearCallback);
    }

    const navigationEntry: NavigationEntry = {
      create() {
        return page;
      },
      context: navigationContext,
      clearHistory: navOptions.clearHistory,
      animated: navOptions.animated,
      transition: navOptions.transition,
    };

    if (isReplace && this.frame.currentPage) {
      this.frame.replacePage(navigationEntry);
    } else {
      this.frame.navigate(navigationEntry);
    }
  }

  // Find and mark the top activated route as an activated one.
  // In ns-location-strategy we are reusing components only if their corresponing routes
  // are marked as activated from this method.
  private markActivatedRoute(activatedRoute: ActivatedRoute) {
    const queue = [];
    queue.push(activatedRoute.snapshot);
    let currentRoute = queue.shift();

    while (currentRoute) {
      currentRoute.children.forEach((childRoute) => {
        queue.push(childRoute);
      });

      const topActivatedRoute = findTopActivatedRouteNodeForOutlet(currentRoute);
      const outletKey = this.locationStrategy.getRouteFullPath(topActivatedRoute);
      const outlet = this.locationStrategy.findOutlet(outletKey, topActivatedRoute);

      if (outlet && outlet.frames.length) {
        topActivatedRoute[pageRouterActivatedSymbol] = true;
        if (NativeScriptDebug.isLogEnabled()) {
          NativeScriptDebug.routerLog('Activated route marked as page: ' + routeToString(topActivatedRoute));
        }
      }

      currentRoute = queue.shift();
    }
  }

  private getComponentFactory(activatedRoute: ActivatedRoute, loadedResolver: ComponentFactoryResolver): ComponentFactory<any> {
    const component = activatedRoute.routeConfig.component || activatedRoute.component;

    return loadedResolver ? loadedResolver.resolveComponentFactory(component) : this.componentFactoryResolver.resolveComponentFactory(component);
  }

  private getOutlet(activatedRouteSnapshot: ActivatedRouteSnapshot): Outlet {
    const topActivatedRoute = findTopActivatedRouteNodeForOutlet(activatedRouteSnapshot);
    const outletKey = this.locationStrategy.getRouteFullPath(topActivatedRoute);
    let outlet = this.locationStrategy.findOutlet(outletKey, topActivatedRoute);

    // Named lazy loaded outlet.
    if (!outlet && this.isEmptyOutlet) {
      const parentOutletKey = this.locationStrategy.getRouteFullPath(topActivatedRoute.parent);
      outlet = this.locationStrategy.findOutlet(parentOutletKey, topActivatedRoute.parent);

      if (outlet) {
        outlet.outletKeys.push(outletKey);
      }
    }

    return outlet;
  }
}
